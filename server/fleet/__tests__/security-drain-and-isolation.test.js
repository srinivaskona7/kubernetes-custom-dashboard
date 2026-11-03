/**
 * The three definitive claims this tab used to make from data that does not support them.
 *
 *  #22  `NetworkPolicy isolation` drew a filled bar from the fraction of app namespaces holding at
 *       least one NetworkPolicy — the weaker of the two claims the collector reports — and the
 *       score was `100` when no app namespace was audited at all.
 *  #14  Direction coverage is read from `policyTypes` and `podSelector`; the allow rules inside a
 *       policy are never evaluated, and the privileged/non-root walk skipped initContainers, so a
 *       privileged init container rendered as `0 Privileged`.
 *
 * The collector halves are unit-tested here; the JSX halves are source-read, because
 * `app/fleet-ui` vitest runs `environment: 'node'` and jsdom cannot be installed on this
 * workstation. The string rules themselves live in `security-isolation.ts` / `pdb-drain.ts` and
 * are unit-tested there.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import security from '../collectors/security.js';

const __dirname = import.meta.dirname;

const TAB = path.join(__dirname, '../../app/fleet-ui/src/pages/cluster-tabs/SecurityTab.tsx');
const tabSource = () => fs.readFileSync(TAB, 'utf8');

const cluster = { id: 'c1', displayName: 'C1', env: 'sbx' };

// ------------------------------------------------------------------ #22 the isolation ratio

test('#22 isolation score is null, not 100, when no app namespace was audited', async () => {
  const fakeList = async ({ path: p }) => {
    // Only system namespaces exist, so `appNamespaces` is empty and there is nothing to divide by.
    if (p.includes('/api/v1/namespaces')) return [{ metadata: { name: 'kube-system' } }];
    return [];
  };
  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.appNamespacesAudited, 0);
  assert.strictEqual(
    result.summary.networkPolicyIsolationScore,
    null,
    'an empty denominator must not render as a full green bar'
  );
});

// ------------------------------------------------------------------ #14 definitive connectivity

test('#14 a privileged initContainer is counted and named, not rendered as 0 Privileged', async () => {
  const fakeList = async ({ path: p }) => {
    if (p.includes('/api/v1/namespaces')) return [{ metadata: { name: 'app-ns' } }];
    if (p.includes('pods')) {
      return [
        {
          metadata: { name: 'p1', namespace: 'app-ns' },
          spec: {
            containers: [{ name: 'app', securityContext: { runAsNonRoot: true } }],
            initContainers: [{ name: 'setup', securityContext: { privileged: true } }],
            ephemeralContainers: [{ name: 'debug' }]
          }
        }
      ];
    }
    return [];
  };
  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.privilegedContainers, 1, 'the privileged init container counts');
  assert.strictEqual(result.summary.totalContainers, 3, 'app + init + ephemeral');
  assert.deepStrictEqual(
    result.privilegedContainerList.map(c => c.container),
    ['setup']
  );
  // The ephemeral container declares nothing, so it is root-capable; the init container is too.
  assert.deepStrictEqual(
    result.rootCapableContainerList.map(c => c.container).sort(),
    ['debug', 'setup']
  );
});

// The heading over the unknown list must carry a count, not a bare label: the rows under it are
// capped at PDB_LIST_CAP and the `+N more` line is a remainder, so without it an operator has no
// total to compare against the blocking list.
// The ratio is nullable on the wire, so every text consumer needs an already-rendered string; a
// caller that glues `%` onto the number prints the literal `null%` on a cluster with no app
// namespaces. See the HANDOFF on srv/fleet/router.js's /report renderer.
test('#22 the collector ships a rendered isolation string, never one a caller must build', async () => {
  const onlySystem = async ({ path: p }) => {
    if (p.includes('/api/v1/namespaces')) return [{ metadata: { name: 'kube-system' } }];
    return [];
  };
  const empty = await security.collect({ cluster, token: 'fake', listFn: onlySystem });
  assert.strictEqual(empty.summary.networkPolicyIsolationScore, null);
  assert.strictEqual(
    empty.summary.networkPolicyIsolationScoreText,
    'not applicable (no app namespaces)'
  );
  assert.ok(
    !JSON.stringify(empty).includes('null%'),
    'no rendered field may contain the literal null%'
  );

  const covered = async ({ path: p }) => {
    if (p.includes('/api/v1/namespaces')) return [{ metadata: { name: 'app-ns' } }];
    if (p.includes('networkpolicies')) {
      return [{ metadata: { name: 'deny', namespace: 'app-ns' }, spec: { podSelector: {} } }];
    }
    return [];
  };
  const scored = await security.collect({ cluster, token: 'fake', listFn: covered });
  assert.strictEqual(scored.summary.networkPolicyIsolationScore, 100);
  assert.strictEqual(scored.summary.networkPolicyIsolationScoreText, '100%');
});

// The clamp is not reachable from any list the collector builds today (the numerator is a subset of
// the denominator), so it is pinned by reading the source: a ratio over 100 must be impossible to
// emit even if a future read changes which namespaces each side counts.
test('#22 the collector clamps the ratio into 0..100 at the source', () => {
  const src = fs.readFileSync(path.join(__dirname, '../collectors/security.js'), 'utf8');
  assert.ok(
    /Math\.min\(100, Math\.max\(0,/.test(src),
    'the isolation score arithmetic must stay clamped'
  );
});

// The collector formatted the figure, declared the reason in a comment, and the renderer kept
// gluing a `%` onto the raw nullable number anyway — so `/report` shipped `Isolation Score null%`
// for a cluster with only system namespaces. A guard on the collector alone could not see that:
// the defect lived one file away, at the only consumer. Source-read because building the whole
// markdown report needs a live fan-out over registered clusters.
test('#22b the markdown /report renders the formatted isolation score, never the raw number', () => {
  const src = fs.readFileSync(path.join(__dirname, '../router.js'), 'utf8');
  const code = src
    .split('\n')
    .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    code.includes('summary.networkPolicyIsolationScoreText'),
    'the report no longer reads the pre-formatted isolation score'
  );
  assert.ok(
    !/networkPolicyIsolationScore\}%/.test(code),
    'the report glues a % onto the nullable isolation score again, which renders the literal null%'
  );
});
