/**
 * The catalogue-field gate.
 *
 * Every field listed here is read by name on a rendered page. Nothing else in the suite
 * notices when a collector stops emitting one: the collector's own tests assert the values it
 * computes, TypeScript describes the shape it *believes* the server sends, and both stay green
 * while a renamed or dropped key turns a live tile into an em-dash. That gap is what this file
 * closes — it runs the real collectors against injected doubles and asserts the key is present.
 *
 * Two rules make it a gate rather than a smoke test:
 *
 * 1. **Presence, not value.** A `0`, a `null` and an empty array all pass. The question is
 *    only whether the key exists, because the UI's own vocabulary (`Count`, `MetricValue`,
 *    `unavailableScope`) already handles every value a present key can carry, and handles
 *    `undefined` as "the field is gone" — silently, as a dash.
 * 2. **Empty doubles.** `listFn` returns `[]` and `callFn` returns `{}`, so no fixture has to
 *    be maintained in step with a collector's internals. A field that only appears when its
 *    resource exists is a field the UI cannot rely on, and belongs behind a guard on the page
 *    rather than in this list — so "emitted on an empty cluster" is exactly the contract.
 *
 * Where a field is nested under `summary` rather than the payload root, this file asserts the
 * exact path. That distinction is not pedantry: `capacity.js` publishes `unavailable` and
 * `truncated` under `summary` while its siblings publish them at the root, and reading them
 * off the root produced a permanently-empty unavailable scope — a refused nodes list rendered
 * as a confident `0` on every tile below it. The `capacity` case below pins both directions.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

const cluster = { id: 'platformsbx', displayName: 'platformsbx', env: 'sbx' };

/** Reads nothing, refuses nothing: a successful list of an empty collection. */
const emptyList = async () => [];
/** A body with no fields — enough for discovery to resolve without a socket. */
const emptyCall = async () => ({});

const ctx = { cluster, token: 'test-token', listFn: emptyList, callFn: emptyCall };

/**
 * Assert `path` (dot-separated) resolves to an own property, however empty its value.
 * Reports the deepest segment that existed, so a rename shows up as "stopped at X" rather
 * than a bare "cannot read property of undefined".
 */
function hasField(root, path, where) {
  const segments = path.split('.');
  let node = root;
  const walked = [];
  for (const segment of segments) {
    assert.ok(
      node !== null && node !== undefined && typeof node === 'object',
      `${where}: ${path} — ${walked.join('.') || '<root>'} is ${JSON.stringify(node)}, cannot descend to "${segment}"`
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(node, segment),
      `${where}: ${path} — "${segment}" is missing from ${walked.join('.') || '<root>'} ` +
      `(has: ${Object.keys(node).join(', ')})`
    );
    node = node[segment];
    walked.push(segment);
  }
}

/**
 * One entry per collector: the module, and the paths a page reads off its payload. The
 * F-numbers are the catalogue's (`docs/research/FEATURE_CATALOGUE_100.md`) — kept here so a
 * failure names the feature that goes blind, not just the key.
 */
const CASES = [
  {
    name: 'storage (F70–F73)',
    collector: '../collectors/storage.js',
    fields: [
      'summary.totalPvcs', 'summary.boundPvcs', 'summary.pendingPvcs',
      'summary.totalRequestedBytes', 'summary.quotasCount',
      // F70: the default-StorageClass verdict, four states including "unread".
      'summary.defaultStorageClassState',
      // F71/F72: LimitRange presence, and the per-object rows behind the count.
      'summary.limitRangesCount', 'limitRanges',
      // F73: null when the namespace denominator could not be read — never 0%.
      'summary.quotaCoverage',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'networking (F63–F65)',
    collector: '../collectors/networking.js',
    fields: [
      'summary.apirulesCount', 'summary.virtualServicesCount', 'summary.ingressesCount',
      'summary.servicesCount',
      // F63: Gateways are counted only on the per-cluster route; /networking drops this.
      'summary.gatewaysCount',
      // F64/F65: the version ledger, the migration backlog, and *why* the count is untrustworthy.
      'summary.apirulesByVersion', 'summary.apirulesNeedingMigration', 'summary.apirulesUnavailable',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'certificates (F83)',
    collector: '../collectors/certificates.js',
    fields: [
      'summary.totalCertificates', 'summary.expiringSoon', 'summary.expired', 'summary.unready',
      // F83: both are per-cluster only — /certificates re-derives its own totals and drops them.
      'summary.providers', 'summary.totalIngressTlsHosts',
      'certificates', 'ingressTls',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'security (F74–F75)',
    collector: '../collectors/security.js',
    fields: [
      'summary.totalNetworkPolicies', 'summary.networkPolicyIsolationScore',
      'summary.privilegedContainers', 'summary.nonRootContainers', 'summary.totalContainers',
      'summary.totalSecretsCount',
      // F74/F75: the denominators that say what the numbers above actually cover.
      'summary.appNamespacesAudited', 'summary.totalNamespaces',
      'summary.totalPodsAudited', 'summary.totalServiceAccounts',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'policy (F67–F69)',
    collector: '../collectors/policy.js',
    fields: [
      // F67: Gatekeeper templates vs the built-in admission policies — three separate counts,
      // because "0 VAPs with 2 bindings" and "2 VAPs with 0 bindings" are opposite findings.
      'summary.constraintTemplateCount',
      'summary.validatingAdmissionPolicyCount', 'summary.validatingAdmissionPolicyBindingCount',
      // F68: a fail-closed webhook whose backend is down takes the cluster with it.
      'summary.failClosedWebhookCount', 'summary.activeOutageRiskCount',
      // F69: null coverage is unavailable, not 0%.
      'summary.pdbCoveragePercent', 'summary.pdbDrainBlockerCount',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'capacity (F76–F78)',
    collector: '../collectors/capacity.js',
    fields: [
      // F76: limit sums, and the flag that says the sum is a floor because containers were
      // unbounded — printing it as a total would understate committed capacity.
      'overcommit.totalCpuLimit', 'overcommit.totalMemoryLimit', 'overcommit.limitSumIsFloor',
      // F77: how much of the limit belongs to injected sidecars rather than the workload.
      'overcommit.sidecarCpuLimitShare', 'overcommit.sidecarMemoryLimitShare',
      // F78: the three unbounded splits. `noEitherLimit` is the INTERSECTION of the first two.
      'unboundedContainers.noCpuLimit', 'unboundedContainers.noMemoryLimit',
      'unboundedContainers.noEitherLimit', 'unboundedContainers.totalEffectiveContainers',
      'qos.counts', 'qos.total', 'pending.count', 'pending.items', 'nodesWithProblems',
      // Tri-state: null means the probe was refused, which is not "not installed".
      'metricsServer.installed', 'metricsServer.reporting', 'metricsServer.reason',
      'summary.unavailable', 'summary.truncated'
    ],
    /**
     * The scope-key contract, pinned in both directions. `CapacitySection` built its
     * unavailable scope from the payload ROOT, where these keys do not live, so the scope was
     * permanently empty and a refused `nodes` read rendered every tile below as a confident 0.
     * If capacity.js ever moves them to the root, this fails and the page must be re-pointed.
     */
    extra(out, where) {
      assert.ok(!Object.prototype.hasOwnProperty.call(out, 'unavailable'),
        `${where}: capacity publishes 'unavailable' under summary only — a root copy would make ` +
        `the two sources of truth disagree; see CapacitySection's envelopeScope(id, c.summary)`);
      assert.ok(!Object.prototype.hasOwnProperty.call(out, 'truncated'),
        `${where}: capacity publishes 'truncated' under summary only`);
    }
  },
  {
    name: 'observability (F79–F80)',
    collector: '../collectors/observability.js',
    fields: [
      // F79: the four Prometheus-Operator object counts as digits, not a pill.
      'prometheusOperator.counts.prometheuses', 'prometheusOperator.counts.servicemonitors',
      'prometheusOperator.counts.podmonitors', 'prometheusOperator.counts.prometheusrules',
      'prometheusOperator.installed',
      // F80: both verdicts carry their own reason — the page prints the collector's, never its own.
      'prometheusOperator.scrapeWiring.verdict', 'prometheusOperator.scrapeWiring.reason',
      'prometheusOperator.alertRules.verdict', 'prometheusOperator.alertRules.reason',
      // Raw API paths, not short labels: the page warns that the counts are floors.
      'prometheusOperator.unavailablePaths',
      'telemetry.installed', 'agentCoverage.recognizedAgents',
      // The pipeline tables read `telemetry.<kind>.pipelines` — the rows, not just the counts.
      'telemetry.logPipelines.pipelines', 'telemetry.logPipelines.total',
      'telemetry.logPipelines.notReady', 'telemetry.logPipelines.flowUnhealthy',
      'telemetry.tracePipelines.pipelines', 'telemetry.metricPipelines.pipelines',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'reliability (F66)',
    collector: '../collectors/reliability.js',
    /**
     * F66: 'unknown' is what turns five empty check lists from "clean" into "never computed".
     * Without it the page cannot tell an operator that a crashlooping container would not
     * have appeared — the single most dangerous false negative in the console.
     */
    fields: ['summary.verdict', 'summary.unavailable', 'summary.truncated']
  },
  {
    name: 'compliance (F81–F82)',
    collector: '../collectors/compliance.js',
    fields: [
      // F81/F82: the rollup, including the fifth number that is neither a pass nor a gap.
      'summary.audited', 'summary.compliant', 'summary.withWarnings', 'summary.withFindings',
      'summary.systemSkipped',
      'namespaces'
    ]
  },
  {
    /**
     * The Modules & Integrity tab reads two collectors, and they are not interchangeable:
     * `platform.js` owns the APIService numbers, `modules.js` owns the Kyma module state.
     * Listing a modules field under integrity is how this list first went wrong.
     */
    name: 'integrity (platform.js)',
    collector: '../collectors/platform.js',
    fields: [
      'summary.totalApiServices', 'summary.aggregatedApiServices', 'summary.unavailableAggregated',
      'summary.unavailable', 'summary.truncated'
    ]
  },
  {
    name: 'modules (modules.js)',
    collector: '../collectors/modules.js',
    fields: [
      'summary.kymaCount', 'summary.moduleCount',
      // Tri-state, like metricsServer.installed: null is "could not tell", not "not managed".
      'summary.kymaManaged', 'summary.unreadableReason',
      'kymas',
      'summary.unavailable', 'summary.truncated'
    ]
  }
];

for (const c of CASES) {
  test(`${c.name}: every field the page reads is emitted on an empty cluster`, async () => {
    const { collect } = (await import(c.collector)).default;
    const out = await collect({ ...ctx });
    for (const path of c.fields) hasField(out, path, c.name);
    if (c.extra) c.extra(out, c.name);
  });
}

/**
 * The gate's own canary. A presence check is worthless if `hasField` passes on a missing key,
 * and that failure mode is silent — every test above would stay green while the console went
 * blind. So prove it goes red: on a rename, on a dropped leaf, and on a path that stops at a
 * non-object (the exact shape of the fleet-wide-vs-per-cluster envelope mix-up).
 */
test('the gate itself fails on a missing, renamed, or too-shallow field', () => {
  assert.doesNotThrow(() => hasField({ summary: { a: 0 } }, 'summary.a', 'canary'));
  // A present-but-empty value still passes: 0, null and [] are all legitimate answers.
  assert.doesNotThrow(() => hasField({ summary: { a: null } }, 'summary.a', 'canary'));
  assert.doesNotThrow(() => hasField({ summary: { a: [] } }, 'summary.a', 'canary'));

  assert.throws(() => hasField({ summary: { b: 0 } }, 'summary.a', 'canary'), /"a" is missing/);
  assert.throws(() => hasField({}, 'summary.a', 'canary'), /"summary" is missing/);
  assert.throws(() => hasField({ summary: 4 }, 'summary.a', 'canary'), /cannot descend to "a"/);
  assert.throws(() => hasField({ summary: null }, 'summary.a', 'canary'), /cannot descend to "a"/);
});
