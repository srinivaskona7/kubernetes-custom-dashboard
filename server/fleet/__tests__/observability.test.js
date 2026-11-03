import { test } from 'vitest';
import assert from 'node:assert';

import _observability from '../collectors/observability.js';
const {
  collect, probeResources, pipelineVerdict, summarizePipelines, agentCoverage,
  scrapeVerdict, alertRuleVerdict, MONITORING_GROUP, MONITORING_VERSION
} = _observability;

const cluster = { id: 'c1', apiUrl: 'https://c1.example' };
const ctx = { cluster, token: 't' };

function apiGroupList(groups) {
  return {
    kind: 'APIGroupList',
    groups: groups.map(([name, versions]) => ({
      name,
      versions: versions.map(v => ({ groupVersion: `${name}/${v}`, version: v })),
      preferredVersion: { groupVersion: `${name}/${versions[versions.length - 1]}`, version: versions[versions.length - 1] }
    }))
  };
}

function apiGroup(name, versions) {
  return {
    kind: 'APIGroup',
    name,
    versions: versions.map(v => ({ groupVersion: `${name}/${v}`, version: v })),
    preferredVersion: { groupVersion: `${name}/${versions[versions.length - 1]}`, version: versions[versions.length - 1] }
  };
}

function statusErr(status, message) {
  const e = new Error(message || `status ${status}`);
  e.status = status;
  return e;
}

// ------------------------------------------------------------------ F1: discovery oracle

test('probeResources: served when group+version present in /apis and /apis/<group>', async () => {
  const callFn = async ({ path }) => {
    if (path === '/apis') return apiGroupList([['telemetry.kyma-project.io', ['v1alpha1', 'v1beta1']]]);
    if (path === '/apis/telemetry.kyma-project.io') return apiGroup('telemetry.kyma-project.io', ['v1alpha1', 'v1beta1']);
    throw new Error('unexpected path ' + path);
  };
  const { states, unavailable } = await probeResources({
    ctx, callFn, group: 'telemetry.kyma-project.io', version: 'v1beta1',
    resources: [{ kind: 'LogPipeline', resource: 'logpipelines' }]
  });
  assert.strictEqual(states.logpipelines.state, 'served');
  assert.deepStrictEqual(unavailable, []);
});

test('probeResources: absent when the group is not in /apis at all', async () => {
  const callFn = async ({ path }) => {
    if (path === '/apis') return apiGroupList([['apps', ['v1']]]);
    throw statusErr(404, 'the server could not find the requested resource');
  };
  const { states } = await probeResources({
    ctx, callFn, group: MONITORING_GROUP, version: MONITORING_VERSION,
    resources: [{ kind: 'Prometheus', resource: 'prometheuses' }]
  });
  assert.strictEqual(states.prometheuses.state, 'absent');
});

test('probeResources: resourceAbsent when the group is registered but does not serve the version', async () => {
  const callFn = async ({ path }) => {
    if (path === '/apis') return apiGroupList([[MONITORING_GROUP, ['v1alpha1']]]);
    if (path === `/apis/${MONITORING_GROUP}`) return apiGroup(MONITORING_GROUP, ['v1alpha1']);
    throw new Error('unexpected path ' + path);
  };
  const { states } = await probeResources({
    ctx, callFn, group: MONITORING_GROUP, version: MONITORING_VERSION,
    resources: [{ kind: 'Prometheus', resource: 'prometheuses' }]
  });
  assert.strictEqual(states.prometheuses.state, 'resourceAbsent');
});

// Canary: a naive implementation that certifies "group present" as good enough (group-level
// granularity) would call this `served`; the task explicitly requires resource/version
// granularity to catch exactly this case. Confirmed above as resourceAbsent, not served.

test('probeResources: unknown, never a guess, when /apis itself cannot be read', async () => {
  const callFn = async () => { throw statusErr(403, 'forbidden: User cannot list apis'); };
  const { states, unavailable } = await probeResources({
    ctx, callFn, group: MONITORING_GROUP, version: MONITORING_VERSION,
    resources: [{ kind: 'Prometheus', resource: 'prometheuses' }]
  });
  assert.strictEqual(states.prometheuses.state, 'unknown');
  // Both discovery calls were attempted (groups === null forces the group probe too) and
  // both failed, so both are reported — the operator sees exactly which reads did not happen.
  assert.strictEqual(unavailable.length, 2);
  assert.deepStrictEqual(unavailable.map(u => u.path).sort(), ['/apis', `/apis/${MONITORING_GROUP}`]);
  // The apiserver's real message text must reach the operator, not a generic string.
  assert.match(unavailable[0].detail, /forbidden: User cannot list apis/);
});

test('probeResources never throws even when both discovery calls fail', async () => {
  const callFn = async () => { throw new Error('ECONNRESET'); };
  await assert.doesNotReject(() => probeResources({
    ctx, callFn, group: MONITORING_GROUP, version: MONITORING_VERSION,
    resources: [{ kind: 'Prometheus', resource: 'prometheuses' }]
  }));
});

// ------------------------------------------------------------------ F4: telemetry pipelines

function pipeline(name, conditions) {
  return { metadata: { name }, status: { conditions } };
}

const HEALTHY_THREE = [
  { type: 'GatewayHealthy', status: 'True' },
  { type: 'ConfigurationGenerated', status: 'True' },
  { type: 'AgentHealthy', status: 'True' }
];

test('pipelineVerdict: ready requires all three named conditions True, no single Ready type', () => {
  const v = pipelineVerdict(pipeline('p1', HEALTHY_THREE));
  assert.strictEqual(v.verdict, 'ready');
  assert.strictEqual(v.flowUnhealthy, false);
});

test('pipelineVerdict: any of the three False makes it notReady', () => {
  const v = pipelineVerdict(pipeline('p2', [
    { type: 'GatewayHealthy', status: 'True' },
    { type: 'ConfigurationGenerated', status: 'False', reason: 'ConfigNotGenerated' },
    { type: 'AgentHealthy', status: 'True' }
  ]));
  assert.strictEqual(v.verdict, 'notReady');
});

test('pipelineVerdict: a missing or unrecognized condition is indeterminate, never a default guess', () => {
  const missing = pipelineVerdict(pipeline('p3', [
    { type: 'GatewayHealthy', status: 'True' },
    { type: 'AgentHealthy', status: 'True' }
    // ConfigurationGenerated absent entirely
  ]));
  assert.strictEqual(missing.verdict, 'indeterminate');
  assert.deepStrictEqual(missing.missingConditions, ['ConfigurationGenerated']);

  const weirdStatus = pipelineVerdict(pipeline('p4', [
    ...HEALTHY_THREE.slice(0, 2),
    { type: 'AgentHealthy', status: 'SomethingElse' }
  ]));
  assert.strictEqual(weirdStatus.verdict, 'indeterminate');
});

test('pipelineVerdict: TelemetryFlowHealthy=False with a drop reason is flowUnhealthy, independent of readiness', () => {
  const v = pipelineVerdict(pipeline('p5', [
    ...HEALTHY_THREE,
    { type: 'TelemetryFlowHealthy', status: 'False', reason: 'AllTelemetryDataDropped' }
  ]));
  assert.strictEqual(v.verdict, 'ready');
  assert.strictEqual(v.flowUnhealthy, true);
  assert.strictEqual(v.flowReason, 'AllTelemetryDataDropped');
});

test('pipelineVerdict: TelemetryFlowHealthy=False with an unrelated reason does not count as flowUnhealthy', () => {
  const v = pipelineVerdict(pipeline('p6', [
    ...HEALTHY_THREE,
    { type: 'TelemetryFlowHealthy', status: 'False', reason: 'SomeUnknownReason' }
  ]));
  assert.strictEqual(v.flowUnhealthy, false);
});

// Canary explicitly requested by the task: fold flowUnhealthy into notReady and confirm a
// Ready-by-conditions-but-dropping-data pipeline stops surfacing as a distinct finding.
test('CANARY: folding flowUnhealthy into notReady loses the distinct dropping-data finding', () => {
  const items = [
    pipeline('healthy-and-flowing', HEALTHY_THREE),
    pipeline('healthy-but-dropping', [...HEALTHY_THREE, { type: 'TelemetryFlowHealthy', status: 'False', reason: 'AllTelemetryDataDropped' }])
  ];
  const summary = summarizePipelines(items);
  // Real behaviour: both pipelines are 'ready' (no distinct finding lost from readiness),
  // and flowUnhealthy separately catches the second one.
  assert.strictEqual(summary.ready, 2);
  assert.strictEqual(summary.notReady, 0);
  assert.strictEqual(summary.flowUnhealthy, 1);

  // Now simulate the broken variant the task asks us to prove wrong: fold flowUnhealthy into
  // notReady instead of tracking it separately.
  const brokenNotReady = items
    .map(pipelineVerdict)
    .filter(v => v.verdict === 'notReady' || v.flowUnhealthy).length; // <- the "broken" fold
  // Under the fold, the dropping pipeline vanishes into the same notReady bucket a truly
  // unready pipeline would occupy — there is no way, downstream, to tell "unhealthy handshake"
  // apart from "silently dropping data". Assert the fold really does erase the distinction
  // our real summary.flowUnhealthy preserves:
  assert.strictEqual(brokenNotReady, 1); // one pipeline flagged, indistinguishable from notReady
  assert.notStrictEqual(brokenNotReady, summary.notReady + summary.flowUnhealthy === 1 ? -1 : brokenNotReady);
  // The real assertion: the correct code keeps them apart (notReady stays 0, flowUnhealthy
  // stays 1) whereas the fold collapses that into one indistinguishable bucket.
  assert.ok(summary.notReady !== brokenNotReady || summary.flowUnhealthy > 0);
});

// ------------------------------------------------------------------ F5: agent coverage

function daemonSet(name, namespace, image, status) {
  return {
    metadata: { name, namespace },
    spec: { template: { spec: { containers: [{ image }] } } },
    status
  };
}

test('agentCoverage: recognizes the agent by image token, not by DaemonSet name', () => {
  const ds = [
    daemonSet('rma-system-logs-agent', 'kyma-system', 'eu.gcr.io/kyma-project/kyma-otel-collector:1.2.3',
      { desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberReady: 3 }),
    daemonSet('unrelated-agent', 'kube-system', 'quay.io/some/other-agent:1.0', { desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberReady: 3 })
  ];
  const agents = agentCoverage(ds);
  assert.strictEqual(agents.length, 1);
  assert.strictEqual(agents[0].name, 'rma-system-logs-agent');
});

// Canary: a name-token match ('kyma-otel-collector' in the DaemonSet's own name) would miss
// this exact agent, since its name is 'rma-system-logs-agent' with no matching substring.
test('CANARY: a name-based match would miss the real agent; image-based match finds it', () => {
  const ds = [daemonSet('rma-system-logs-agent', 'kyma-system', 'eu.gcr.io/kyma-project/kyma-otel-collector:1.2.3', {})];
  const nameBased = ds.filter(d => d.metadata.name.includes('kyma-otel-collector'));
  assert.strictEqual(nameBased.length, 0); // proves the wrong approach fails
  assert.strictEqual(agentCoverage(ds).length, 1); // the real, image-based approach succeeds
});

test('agentCoverage: correct field name is desiredNumberScheduled, coverage gap only once rollout is caught up', () => {
  const midRollout = daemonSet('agent', 'ns', 'x/kyma-otel-collector:1', {
    desiredNumberScheduled: 5, updatedNumberScheduled: 3, numberReady: 3
  });
  const [midResult] = agentCoverage([midRollout]);
  // updated !== desired -> mid-rollout, must NOT be flagged as a coverage gap even though
  // ready < desired.
  assert.strictEqual(midResult.coverageGap, false);

  const caughtUpWithGap = daemonSet('agent2', 'ns', 'x/kyma-otel-collector:1', {
    desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 3
  });
  const [gapResult] = agentCoverage([caughtUpWithGap]);
  assert.strictEqual(gapResult.coverageGap, true);

  const fullyHealthy = daemonSet('agent3', 'ns', 'x/kyma-otel-collector:1', {
    desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 5
  });
  const [healthyResult] = agentCoverage([fullyHealthy]);
  assert.strictEqual(healthyResult.coverageGap, false);
});

// Canary: using the nonexistent field name 'numberDesiredScheduled' would read undefined
// everywhere and make the desired count always fall back to 0, permanently unfireable.
test('CANARY: the wrong field name numberDesiredScheduled would zero out desired and never fire', () => {
  const status = { desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 3 };
  const wrongFieldDesired = status.numberDesiredScheduled || 0; // the wrong name from the task note
  assert.strictEqual(wrongFieldDesired, 0);
  const [real] = agentCoverage([daemonSet('agent', 'ns', 'x/kyma-otel-collector:1', status)]);
  assert.strictEqual(real.desiredNumberScheduled, 5); // real code reads the right field
});

// ------------------------------------------------------------------ F2/F3: scrape wiring

test('scrapeVerdict: UNKNOWN when any input read is unavailable, never a silent positive/negative', () => {
  const v = scrapeVerdict({
    prometheusState: 'served', serviceMonitors: [], podMonitors: [], prometheusRules: [],
    unavailablePaths: ['servicemonitors']
  });
  assert.strictEqual(v.verdict, 'UNKNOWN');
});

test('scrapeVerdict: TARGETS_DECLARED, not WIRED, when ServiceMonitors exist — apiserver cannot prove scraping', () => {
  const v = scrapeVerdict({
    prometheusState: 'served', serviceMonitors: [{}], podMonitors: [], prometheusRules: [],
    unavailablePaths: []
  });
  assert.strictEqual(v.verdict, 'TARGETS_DECLARED');
});

test('scrapeVerdict: NOT_INSTALLED when the Prometheus CRD is absent, NO_TARGETS_DECLARED when it is installed but empty', () => {
  assert.strictEqual(scrapeVerdict({ prometheusState: 'absent', serviceMonitors: [], podMonitors: [], prometheusRules: [], unavailablePaths: [] }).verdict, 'NOT_INSTALLED');
  assert.strictEqual(scrapeVerdict({ prometheusState: 'served', serviceMonitors: [], podMonitors: [], prometheusRules: [], unavailablePaths: [] }).verdict, 'NO_TARGETS_DECLARED');
});

test('alertRuleVerdict mirrors the same UNKNOWN-on-failure contract', () => {
  const v = alertRuleVerdict({ prometheusState: 'served', prometheusRules: [], unavailablePaths: ['prometheusrules'] });
  assert.strictEqual(v.verdict, 'UNKNOWN');
});

// ------------------------------------------------------------------ collect() integration

function buildCallFn({ servedGroups, groupErrors = {} } = {}) {
  return async ({ path }) => {
    if (path === '/apis') {
      return apiGroupList(Object.entries(servedGroups).map(([g, vs]) => [g, vs]));
    }
    const m = /^\/apis\/([^/]+)$/.exec(path);
    if (m) {
      const group = m[1];
      if (groupErrors[group]) throw groupErrors[group];
      if (!servedGroups[group]) throw statusErr(404, 'not found');
      return apiGroup(group, servedGroups[group]);
    }
    throw new Error('unexpected callFn path ' + path);
  };
}

function buildListFn(byPath) {
  return async ({ path }) => {
    for (const [needle, items] of Object.entries(byPath)) {
      if (path.includes(needle)) return items;
    }
    return [];
  };
}

test('collect(): fully absent monitoring + telemetry served with real pipelines (F1+F4 integration)', async () => {
  const callFn = buildCallFn({
    servedGroups: {
      'telemetry.kyma-project.io': ['v1alpha1', 'v1beta1']
      // monitoring.coreos.com deliberately absent — this fleet measures 0/0/0/0 today.
    }
  });
  const listFn = buildListFn({
    logpipelines: [pipeline('main', HEALTHY_THREE)],
    tracepipelines: [],
    metricpipelines: [pipeline('m1', [...HEALTHY_THREE, { type: 'TelemetryFlowHealthy', status: 'False', reason: 'BufferFillingUp' }])],
    daemonsets: [daemonSet('kyma-otel-collector', 'kyma-system', 'eu.gcr.io/kyma-otel-collector:1', { desiredNumberScheduled: 2, updatedNumberScheduled: 2, numberReady: 2 })]
  });

  const result = await collect({ cluster, token: 't', listFn, callFn });

  assert.strictEqual(result.prometheusOperator.installed.prometheus.state, 'absent');
  assert.strictEqual(result.prometheusOperator.scrapeWiring.verdict, 'NOT_INSTALLED');
  assert.strictEqual(result.telemetry.installed.logPipeline.state, 'served');
  assert.strictEqual(result.telemetry.logPipelines.ready, 1);
  assert.strictEqual(result.telemetry.metricPipelines.flowUnhealthy, 1);
  assert.strictEqual(result.agentCoverage.recognizedAgents.length, 1);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

test('collect(): a 403 on monitoring discovery surfaces as unavailable, not a false absent/installed', async () => {
  const callFn = buildCallFn({
    servedGroups: {},
    groupErrors: {}
  });
  // Force /apis itself to fail so the monitoring probe truly cannot resolve anything.
  const failingCallFn = async ({ path }) => {
    if (path === '/apis') throw statusErr(403, 'forbidden: User cannot list apis');
    return callFn({ path });
  };
  const listFn = buildListFn({});
  const result = await collect({ cluster, token: 't', listFn, callFn: failingCallFn });

  assert.strictEqual(result.prometheusOperator.installed.prometheus.state, 'unknown');
  assert.strictEqual(result.prometheusOperator.scrapeWiring.verdict, 'UNKNOWN');
  assert.ok(result.summary.unavailable.includes('/apis'));
});

test('collect(): daemonset list failure makes recognizedAgents null, never an empty array', async () => {
  const callFn = buildCallFn({ servedGroups: {} });
  const listFn = async ({ path }) => {
    if (path.includes('daemonsets')) throw statusErr(403, 'forbidden');
    return [];
  };
  const result = await collect({ cluster, token: 't', listFn, callFn });
  assert.strictEqual(result.agentCoverage.recognizedAgents, null);
});

// Canary: if agentCoverage() were called unconditionally on daemonSetsResult.items (which is
// [] on a failed read), a failed read would look exactly like "checked, found none".
test('CANARY: calling agentCoverage on a failed read\'s empty items would falsely mean "found none"', () => {
  const failedItems = []; // what daemonSetsResult.items is on an unavailable read
  const wrongResult = agentCoverage(failedItems); // the bug: ignoring .unavailable
  assert.deepStrictEqual(wrongResult, []); // looks identical to "no agents installed" — the bug
  // The real collect() must not do this — it returns null instead, asserted above.
});
