/**
 * The capability vocabulary: the one rule, and the two sentences the spec fixes word for word.
 *
 * ## The one rule
 *
 * A missing permission never becomes an empty result and never becomes a healthy one. Everything
 * below is a way of stating that: a 403 anywhere in a feature's reads makes the feature
 * `forbidden` even when other reads in the set succeeded, `trusted` is false for every state whose
 * numbers are placeholders, and an unconfirmed absence is `unknown` rather than `not-installed`.
 *
 * ## The two fixed sentences
 *
 * Two sentences are specified verbatim, because they are the ones that tell an operator which of
 * six identical-looking empty screens they are looking at and who has to fix it:
 *
 *   "Helm release history is unavailable because the read-only service account cannot access the
 *    configured Helm Secret storage."
 *   "OPA Decision Activity is unavailable because admission decision telemetry is not configured."
 *
 * The Helm one is asserted here through the real collector on a real 403, not against
 * `capability()` directly — the sentence is generated from the feature name and the read label, and
 * a unit test that passed both by hand would keep passing after either drifted. The OPA one is
 * asserted the same way in `opa.test.js`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import cap from '../capability.js';
import helm from '../collectors/helm.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

const read = (label, over = {}) => ({
  label,
  unavailable: false,
  reason: null,
  detail: null,
  truncated: false,
  absent: false,
  absentEvidence: null,
  ...over
});

test('a refused read makes the feature forbidden, never an empty or healthy one', () => {
  const verdict = cap.fromReads({
    feature: 'Test feature',
    reads: [read('secrets', { unavailable: true, reason: 'FORBIDDEN', detail: 'secrets is forbidden' }), read('pods')],
    gotAnything: true
  });

  assert.equal(verdict.state, 'forbidden');
  assert.equal(verdict.trusted, false, 'a number beside a forbidden verdict must not read as a fact');
  assert.match(verdict.sentence, /the read-only service account cannot access secrets/);
  assert.deepEqual(verdict.missing, ['secrets']);
  // CANARY: partial would be the tempting verdict here, because `pods` succeeded. It is the wrong
  // one — the missing slice is missing for a reason an admin can fix, and "partially available"
  // sends the operator looking for a cluster problem instead of a role binding.
  assert.notEqual(verdict.state, 'partial');
});

test('a confirmed absence is a real zero; an unconfirmed one is unknown', () => {
  const installed = cap.fromReads({
    feature: 'Gatekeeper',
    reads: [read('constrainttemplates', { unavailable: true, reason: null, absent: true, absentEvidence: 'no such API group' })],
    gotAnything: false
  });
  assert.equal(installed.state, 'not-installed');
  assert.equal(installed.trusted, true, 'a CRD that is genuinely absent makes its counts true zeros');

  const unproven = cap.fromReads({
    feature: 'Gatekeeper',
    reads: [read('constrainttemplates', { absent: null, absentEvidence: 'the discovery probe did not answer' })],
    gotAnything: false
  });
  assert.equal(unproven.state, 'unknown');
  assert.equal(unproven.trusted, false);
  // CANARY: guessing between "absent" and "refused" is the most expensive lie this console could
  // tell, so the eighth state exists precisely to refuse the guess.
  assert.notEqual(unproven.state, 'not-installed');
});

test('every state declares whether the numbers beside it may be read as facts', () => {
  const trust = state => cap.capability({ feature: 'f', state, cause: 'a cause' }).trusted;

  assert.equal(trust('available'), true);
  assert.equal(trust('stale'), true, 'a stale number was true, and its timestamp is shown beside it');
  assert.equal(trust('not-installed'), true, 'nothing installed is a real zero');
  for (const state of ['forbidden', 'unsupported-backend', 'not-configured', 'unknown', 'partial']) {
    assert.equal(trust(state), false, `${state} carries no trustworthy number`);
  }
  // An unrecognised state degrades to `unknown` rather than to something trusted.
  assert.equal(cap.capability({ feature: 'f', state: 'invented' }).state, 'unknown');
  assert.equal(trust('invented'), false);
});

test('a feature with no cause says it could not determine why, rather than nothing', () => {
  const verdict = cap.capability({ feature: 'Test feature', state: 'unknown' });
  assert.equal(verdict.sentence, 'Test feature is unavailable and this console could not determine why.');
});

test('an available feature carries no sentence — there is nothing to explain', () => {
  assert.equal(cap.available('Test feature').sentence, null);
});

test('a forbidden Helm store produces the exact sentence the specification fixes', async () => {
  const forbidden = async () => {
    const err = new Error('secrets is forbidden: User "system:serviceaccount:x:y" cannot list resource "secrets"');
    err.status = 403;
    throw err;
  };

  const payload = await helm.manifest({
    cluster,
    token: 't',
    listFn: forbidden,
    namespace: 'demo',
    name: 'bookshop'
  });

  assert.equal(
    payload.capability.sentence,
    'Helm release history is unavailable because the read-only service account cannot access the configured Helm Secret storage.'
  );
  assert.equal(payload.capability.state, 'forbidden');
  assert.equal(payload.capability.trusted, false);

  // The response is the full shape with everything empty, not a shape missing its fields: a
  // consumer explaining why it has no values must not fall over reaching for them.
  assert.deepEqual(payload.values, {});
  assert.deepEqual(payload.overrides, {});
  assert.deepEqual(payload.defaults, {});
  assert.equal(payload.hasChartDefaults, false);
  assert.deepEqual(payload.documents, []);
  assert.equal(payload.chartMetadata.name, null);
  assert.deepEqual(payload.chartMetadata.keywords, []);
  // CANARY: a 403 must never come back as "release not found". The two send an operator to
  // completely different places, and only one of them is fixable with a role binding.
  assert.equal(payload.revision, null);
});

test('a refusal on both Helm drivers names one store and keeps the evidence', async () => {
  const forbidden = async () => {
    const err = new Error('cannot list resource "secrets"');
    err.status = 403;
    throw err;
  };

  const result = await helm.collect({ cluster, token: 't', listFn: forbidden });
  const verdict = result.capabilities.releases;

  // The sentence names the one store that exists, not the two probes this console made.
  assert.equal(
    verdict.sentence,
    'Helm release storage is unavailable because the read-only service account cannot access the configured Helm Secret storage.'
  );
  assert.doesNotMatch(verdict.sentence, /ConfigMap/, 'the probing strategy is not the operator’s problem');
  // The facts the shortened sentence dropped are still on the verdict for whoever debugs the RBAC.
  assert.match(String(verdict.detail), /every Kubernetes-backed Helm driver was refused/);
  assert.match(String(verdict.detail), /ConfigMap/);
  assert.deepEqual(verdict.missing, [
    'the configured Helm Secret storage',
    'the configured Helm ConfigMap storage'
  ]);
  // And the completeness list keeps its own terse vocabulary, which is a separate contract. (This
  // listFn refuses everything, so the health reads are in there too.)
  assert.deepEqual(result.summary.unavailable.slice(0, 2), [
    'helm release storage (Secrets)',
    'helm release storage (ConfigMaps)'
  ]);
});

test('the release list separates the store verdict from live inspection', async () => {
  // Secrets and ConfigMaps refused, every other read fine: the three record-derived panes die and
  // live inspection survives, because they need different RBAC.
  const listFn = async ({ path }) => {
    if (path.includes('/secrets') || path.includes('/configmaps')) {
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    }
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.equal(result.capabilities.releases.state, 'forbidden');
  assert.equal(
    result.capabilities.history.sentence,
    'Helm release history is unavailable because the read-only service account cannot access the configured Helm Secret storage.'
  );
  assert.equal(
    result.capabilities.values.sentence,
    'Helm release values are unavailable because the read-only service account cannot access the configured Helm Secret storage.'
  );
  assert.equal(
    result.capabilities.manifest.sentence,
    'The Helm rendered manifest is unavailable because the read-only service account cannot access the configured Helm Secret storage.'
  );
  // CANARY: the whole point of a separate verdict. If live inspection ever inherits the storage
  // state, an operator locked out of Helm's records loses the view of what is actually running.
  assert.equal(result.capabilities.liveInspection.state, 'available');
  assert.equal(result.capabilities.liveInspection.trusted, true);

  // And the count is not a comforting zero: the verdict beside it says it cannot be trusted.
  assert.equal(result.counts.releases, 0);
  assert.equal(result.capabilities.releases.trusted, false);
});

test('an empty but readable store reports the zero AND the SQL ambiguity', async () => {
  const result = await helm.collect({ cluster, token: 't', listFn: async () => [] });

  assert.equal(result.storage.backend, 'none');
  assert.equal(result.capabilities.releases.state, 'available');
  assert.match(
    String(result.capabilities.releases.extra.note),
    /HELM_DRIVER=sql/,
    'a cluster with no releases and an SQL-backed one are indistinguishable from here, and that has to be said'
  );
  assert.equal(result.capabilities.releases.extra.sqlIndistinguishable, true);
});
