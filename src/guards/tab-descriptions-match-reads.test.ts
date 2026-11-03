// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * A tab description is a promise about what was read — so it is tested against the collector.
 *
 * Three descriptions promised reads that no collector makes, and each one sent an operator to the
 * wrong screen with a conclusion already formed:
 *
 *   - Networking said "…and NetworkPolicies". `networking.js` issues no networkpolicies request; the
 *     only reads are in `security.js`, `compliance.js` and `helm-related.js`. An operator read
 *     "isolation was evaluated here" off a screen that evaluates nothing.
 *   - observability promised pipeline "destinations". `observability.js` projects no
 *     destination, output or host field, so "where are my logs shipped" was invited and unanswerable.
 *   - security/isolation said "mesh policy". `security.js` reads namespaces, networkpolicies, pods,
 *     secrets and serviceaccounts — Istio PeerAuthentication and AuthorizationPolicy are `mesh.js`,
 *     rendered on `?tab=network&section=mesh`. The first fix of the networking line routed the
 *     operator *to* this screen, which made the over-claim here the destination's own problem.
 *
 * The opposite failure is also guarded: an **under**-description. `observability` renders
 * three panels, and a one-clause label naming only the pipelines deletes the operator's provenance
 * for the other two. Every assertion here is claim-shaped rather than string-shaped — it must fail on
 * a paraphrase of the wrong claim, not only on the original punctuation.
 *
 * The assertions below are deliberately two-sided: each pairs a forbidden word in the description
 * with a grep over the collector that *would* have to read it. If a collector later grows the read,
 * the guard fails and asks for the description back — it does not silently bless the old wording.
 *
 * Also pinned: the HPA `Status` pill goes through `hpaStatus()` rather than an inline
 * `ScalingActive === 'True' ? Active : Degraded`, which asserted Degraded about an unreconciled HPA
 * and Active about one pinned at its ceiling. The rule itself is unit-tested in
 * `autoscaling-format.test.ts`; this half only pins that the JSX consumes it, because jsdom is
 * unavailable here and the .tsx can otherwise drift back with the compiler's blessing.
 */





const ROOT = path.resolve(FAKE_DIR, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** Comments say what the code used to do, so every assertion here reads the code only. */
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const TABS = code(read('src', 'pages', 'cluster-tabs', 'tabs.ts'));
const AUTOSCALING_TAB = code(read('src', 'pages', 'cluster-tabs', 'AutoscalingTab.tsx'));

/** The `description:` string literal belonging to one `?section=` id. */
function descriptionsFor(sectionId) {
  const re = new RegExp(`id: '${sectionId}'[\\s\\S]{0,400}?description:\\s*\\n?\\s*'([^']*)'`);
  const m = re.exec(TABS);
  assert.ok(m, `no description found for section id '${sectionId}' — did the id get renamed?`);
  return m[1];
}

function tabAbout(tab) {
  const body = TABS.slice(TABS.indexOf('export const TAB_ABOUT'));
  const re = new RegExp(`\\n  ${tab}:\\s*(?:\\n\\s*)?'((?:[^'\\\\]|\\\\.)*)'`);
  const m = re.exec(body);
  assert.ok(m, `no TAB_ABOUT entry for '${tab}'`);
  return m[1];
}

test('the networking section does not claim a NetworkPolicy read its collector never makes', () => {
  const collector = read('server', 'fleet', 'collectors', 'networking.js');
  const reads = /networkpolicies/i.test(collector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
  // A promise is "Reads … NetworkPolicies"; naming the screen that *does* read them is the fix,
  // not a relapse, so the pattern is anchored on the verb.
  const promises =
    /Reads[^.]*NetworkPolic/i.test(descriptionsFor('networking')) || /Reads[^.]*NetworkPolic/i.test(tabAbout('network'));
  assert.strictEqual(
    promises,
    reads,
    reads
      ? 'networking.js now reads networkpolicies — say so in the description'
      : 'networking.js reads no networkpolicies; the description must not promise them'
  );
  // And it must hand the operator the screen that does evaluate isolation.
  assert.match(descriptionsFor('networking'), /Security & Isolation/);
  assert.match(tabAbout('network'), /Security & Isolation/);
  // Correcting an over-claim must not introduce an under-claim: networking.js issues six reads, and
  // the Gateways one was dropped from both labels while the NetworkPolicy clause was being removed.
  const bare = code(collector);
  assert.match(bare, /'istio-gateways'/, 'the Istio Gateways read is gone from networking.js');
  assert.match(descriptionsFor('networking'), /Gateways/i, 'networking.js reads Istio Gateways — say so');
  assert.match(tabAbout('network'), /Gateways/i, 'networking.js reads Istio Gateways — say so');
});

test('observability describes every panel it renders, and promises no destination', () => {
  const collector = read('server', 'fleet', 'collectors', 'observability.js');
  const projects = /\b(destination|output|host)\s*:/i.test(collector);
  assert.strictEqual(projects, false, 'observability.js now projects a destination — say so in the description');
  const description = descriptionsFor('telemetry');
  // Claim-shaped, not string-shaped: any wording is fine as long as every clause that mentions a
  // destination denies it. A relapse to "…and their destinations." fails whatever the punctuation.
  const destinationClaims = description
    .split(/[.;—]/)
    .filter(c => /destination|where[^.]*(shipped|sent)/i.test(c));
  for (const clause of destinationClaims) {
    assert.match(clause, /\b(never|not|no)\b/i, `this clause offers a destination the collector never reads: "${clause.trim()}"`);
  }
  assert.strictEqual(destinationClaims.length > 0, true, 'the description no longer says destinations are out of reach');

  // The section's description is the operator's only provenance for its panels, so it has to name
  // every read behind a panel it renders. The Prometheus-Operator panel is rendered only when the
  // tab does not hide it, and the description has to follow that either way.
  const reads = label => new RegExp(`'${label}'`).test(collector);
  assert.ok(reads('servicemonitors') && reads('prometheusrules'), 'the Prometheus-Operator reads are gone');
  assert.ok(reads('daemonsets'), 'the OTel agent DaemonSet read is gone');
  assert.ok(reads('logpipelines'), 'the telemetry pipeline reads are gone');
  const tab = code(read('src', 'pages', 'cluster-tabs', 'ObservabilityTab.tsx'));
  const rendersOperator = !/<ObservabilitySection[^>]*\bhidePrometheusOperator\b/.test(tab);
  assert.strictEqual(
    /Prometheus-Operator/i.test(description),
    rendersOperator,
    rendersOperator ? 'the Prometheus-Operator panel is rendered but not described' : 'the description names a panel the tab hides'
  );
  assert.match(description, /DaemonSet/i, 'the OTel agent DaemonSet panel is rendered but not described');
  assert.match(description, /pipeline/i, 'the telemetry pipeline panel is rendered but not described');
  assert.match(tabAbout('observability'), /Prometheus-Operator/i, 'TAB_ABOUT drops the Prometheus-Operator read');
  assert.match(tabAbout('observability'), /agent coverage/i, 'TAB_ABOUT drops the OTel agent DaemonSet read');
});

test('security does not claim the mesh policy read its collector never makes', () => {
  const collector = code(read('server', 'fleet', 'collectors', 'security.js'));
  const reads = /peerauthentications|authorizationpolicies/i.test(collector);
  // Two-sided, and anchored on the verb so that naming the screen which *does* evaluate mTLS is not
  // read as a relapse. mesh.js owns those objects and renders them on network/mesh.
  const promises =
    /Reads[^.]*(mesh polic|PeerAuthentication|AuthorizationPolic|mTLS)/i.test(descriptionsFor('isolation')) ||
    /Reads[^.]*(PeerAuthentication|AuthorizationPolic|mTLS)/i.test(tabAbout('security'));
  assert.strictEqual(
    promises,
    reads,
    reads
      ? 'security.js now reads Istio policy — say so in the description'
      : 'security.js reads no PeerAuthentication or AuthorizationPolicy; the label must not promise mesh policy'
  );
  // And it must hand the operator the screen that does evaluate it: the Istio & Mesh tab, whose one
  // section is "Mesh security" (tabs.ts). "Service Mesh" named a tab that no longer exists.
  assert.match(tabAbout('security'), /Istio & Mesh[^.]*Mesh security/);
  assert.match(descriptionsFor('isolation'), /Istio & Mesh[^.]*Mesh security/);
  assert.match(code(read('server', 'fleet', 'collectors', 'mesh.js')), /peerauthentications/i);
});

test('the autoscaling descriptions do not claim a Jobs read', () => {
  const collector = read('server', 'fleet', 'collectors', 'autoscaling.js');
  assert.doesNotMatch(collector, /batch\/v1\/jobs/);
  assert.doesNotMatch(tabAbout('workloads'), /\bJobs from batch\/v1/);
  assert.doesNotMatch(descriptionsFor('cronjobs'), /recent Job outcomes/);
});

test('the HPA Status pill is computed by hpaStatus, not inline', () => {
  assert.match(AUTOSCALING_TAB, /import \{[^}]*\bhpaStatus\b[^}]*\} from '\.\/autoscaling-format'/);
  assert.match(AUTOSCALING_TAB, /sortValue: h => hpaStatus\(h\)\.rank/);
  assert.match(AUTOSCALING_TAB, /const s = hpaStatus\(h\);/);
  assert.doesNotMatch(AUTOSCALING_TAB, /Degraded/, 'the two-state pill vocabulary is back');
});

test('the Overview description names every read it makes, not just the summary', () => {
  /*
    This description is the only provenance the Overview offers, and it said "Arrives in a single
    GET /clusters/:id/summary" for as long as that was true. The namespace list is a second call
    to a different route, so the sentence became a claim the network tab disproves — the exact
    failure this file exists to catch, committed by the same change that added the read.
  */
  const about = tabAbout('overview');
  assert.match(about, /\/clusters\/:id\/summary/, 'the summary read is no longer named');
  assert.match(
    about,
    /\/clusters\/:id\/namespaces/,
    'OverviewTab reads the namespace list for its Pod counts and the description does not say so'
  );
  assert.doesNotMatch(
    about,
    /\bsingle\b|\bone request\b/i,
    'the description still claims one request while the tab makes two'
  );

  assert.doesNotMatch(
    about,
    /\/clusters\/:id\/workloads/,
    'the Overview no longer reads workloads (the namespace cards were removed), yet the description names that read'
  );

  /*
    The read lives in the tile component, not in the tab shell. Asserting against the tab file
    alone would pass forever once the call moved out of it, which is the direction this half of the
    test guards: a description that names a route nothing fetches any more.
  */
  const tile = read('src', 'pages', 'cluster-tabs', 'NamespacesTile.tsx');
  assert.match(tile, /api\.namespaces\(/, 'the namespace read is gone, so the description now over-claims');
  assert.doesNotMatch(tile, /api\.workloads\(/, 'the tile reads workloads now and the description does not say so');

  const tab = read('src', 'pages', 'cluster-tabs', 'OverviewTab.tsx');
  assert.match(tab, /<NamespacesTile\b/, 'the Overview no longer renders the Namespaces tile');
  assert.doesNotMatch(
    tab,
    /<NamespaceCards\b/,
    'the per-namespace card grid is back on the Overview; it duplicates Namespaces & Workloads → Namespaces'
  );
});
