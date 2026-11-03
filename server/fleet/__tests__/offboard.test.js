
/**
 * De-registering a cluster: what it deletes, what it refuses, and what it must never touch.
 *
 * The control was removed from the UI once already, for a good reason — a one-click offboard
 * beside a row of live clusters is a mis-click away from blinding the fleet. It is back because
 * the operator asked for it, in a place and a shape that a mis-click cannot reach, and these are
 * the properties that make putting it back defensible:
 *
 *  - It writes the *dashboard's* two records and nothing else. No call is made to the cluster.
 *    That is the whole reason a read-only console may offer it at all, so it is asserted against
 *    the transport rather than inferred from reading the handler.
 *  - It tells the operator what it left running on their cluster. A console that silently
 *    abandons a ServiceAccount and a ClusterRole on someone's cluster has told them nothing.
 *  - The flags the UI reads to decide whether to show the control agree with the handler's own
 *    refusals. A control offered and then refused is worse than no control.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;

/**
 * Turn the admin gate off for one test, and put it back.
 *
 * The harness's identity carries no scopes, so with the gate on — the default, and the shape
 * every test that does *not* call this proves — every route below answers 403. That is the
 * first property asserted, and the reason the rest of this file has to opt out explicitly
 * rather than running in a world where the gate happens not to apply.
 */
function disableAdminScope(t) {
  const before = process.env.FLEET_REQUIRE_ADMIN_SCOPE;
  process.env.FLEET_REQUIRE_ADMIN_SCOPE = 'false';
  t.onTestFinished(() => {
    if (before === undefined) delete process.env.FLEET_REQUIRE_ADMIN_SCOPE;
    else process.env.FLEET_REQUIRE_ADMIN_SCOPE = before;
  });
}

/**
 * Undo a removal at the end of a test.
 *
 * `Registry.remove` writes to a module-level set as well as the instance's own, so a cluster
 * removed in one `withRouter` stays removed in the next one in the same process — the first
 * version of this file removed `demo-dev` in its first test and every later test 404'd. The
 * sharing is deliberate in production (it is how a replica learns about an offboard); here it
 * just has to be undone.
 */
function restore(t, registry, id) {
  t.onTestFinished(() => registry.unremove(id));
}

/** A writer pair that records rather than writes, so a test can see exactly what was asked. */
function recordingWriters() {
  const removed = { clusters: [], tokens: [] };
  return {
    removed,
    clusterWriter: {
      remove: async id => void removed.clusters.push(id),
      patch: async () => {},
      write: async () => {}
    },
    tokenWriter: {
      remove: async id => void removed.tokens.push(id),
      write: async () => {}
    }
  };
}

test('an account without the admin scope cannot de-register anything', async () => {
  // No `disableAdminScope` here on purpose: this is the default posture, and the harness's
  // identity carries no scopes. All three spellings must refuse, and the refusal must come
  // *before* the writers are touched — a 403 that has already deleted the record is not a 403.
  const { removed, clusterWriter, tokenWriter } = recordingWriters();

  await withRouter({ clusterWriter, tokenWriter }, async ({ get, registry }) => {
    for (const [method, suffix] of [['DELETE', ''], ['POST', '/remove'], ['POST', '/delete']]) {
      const res = await get(`/clusters/demo-dev${suffix}`, { method });
      assert.equal(res.status, 403, `${method} /clusters/demo-dev${suffix}`);
      assert.equal(res.body.code, 'MISSING_SCOPE');
    }
    assert.deepEqual(removed.clusters, [], 'nothing may be written on a refused call');
    assert.deepEqual(removed.tokens, []);
    assert.ok(registry.get('demo-dev'), 'the cluster must still be registered');
  });
});

test('with the gate on, the UI is told not to offer the control', async () => {
  // The other half of the same property: `canRemove` must agree with the 403 above, or the
  // console shows a red button that answers "this account lacks the scope" on every press.
  const { clusterWriter, tokenWriter } = recordingWriters();
  await withRouter({ clusterWriter, tokenWriter }, async ({ get }) => {
    const res = await get('/tokens');
    assert.equal(res.body.canRemove, false);
  });
});

test('removing a cluster deletes its record and its token, and contacts no cluster', async t => {
  disableAdminScope(t);
  const { removed, clusterWriter, tokenWriter } = recordingWriters();
  const contacted = [];

  await withRouter(
    {
      clusterWriter,
      tokenWriter,
      // Every transport seam records instead of answering. The handler must reach none of them:
      // offboarding is bookkeeping in this process, not an act against the target cluster.
      listFn: async ({ path }) => { contacted.push(path); return { items: [] }; },
      callFn: async ({ path }) => { contacted.push(path); return {}; },
      textFn: async ({ path }) => { contacted.push(path); return ''; }
    },
    async ({ get, registry }) => {
      assert.ok(registry.get('demo-dev'), 'the fixture cluster must exist before it is removed');

      const res = await get('/clusters/demo-dev/remove', { method: 'POST' });

      assert.equal(res.status, 200);
      assert.equal(res.body.removed, true);
      assert.equal(res.body.cluster, 'demo-dev');
      assert.deepEqual(removed.clusters, ['demo-dev']);
      assert.deepEqual(removed.tokens, ['demo-dev'], 'the token record goes with the cluster record');
      assert.deepEqual(contacted, [], 'offboarding must not issue a single call to the cluster');
      assert.equal(registry.get('demo-dev'), null, 'the registry must forget it immediately');
      restore(t, registry, 'demo-dev');
    }
  );
});

test('the response names what is still running on the cluster', async t => {
  disableAdminScope(t);
  // The objects the fleet left behind are real and the operator has to remove them by hand;
  // a removal that says "done" and nothing else is how a ServiceAccount outlives its purpose
  // on someone else's cluster forever.
  const { clusterWriter, tokenWriter } = recordingWriters();

  await withRouter({ clusterWriter, tokenWriter }, async ({ get, registry }) => {
    const res = await get('/clusters/demo-dev/remove', { method: 'POST' });
    restore(t, registry, 'demo-dev');
    const left = res.body.leftBehind;

    assert.equal(typeof left, 'string');
    assert.match(left, /kubectl delete ns /, 'the namespace command must be spelled out');
    assert.match(left, /kubectl delete clusterrole /);
    assert.match(left, /kubectl delete clusterrolebinding /);
  });
});

test('all three spellings of the route do the same thing', async t => {
  disableAdminScope(t);
  // DELETE, POST /remove and POST /delete are three aliases of one handler. A client that
  // cannot send DELETE has the other two, and they must not drift into three behaviours.
  for (const [method, suffix] of [['DELETE', ''], ['POST', '/remove'], ['POST', '/delete']]) {
    const { removed, clusterWriter, tokenWriter } = recordingWriters();
    await withRouter({ clusterWriter, tokenWriter }, async ({ get, registry }) => {
      const res = await get(`/clusters/demo-dev${suffix}`, { method });
      registry.unremove('demo-dev');
      assert.equal(res.status, 200, `${method} /clusters/demo-dev${suffix}`);
      assert.deepEqual(removed.clusters, ['demo-dev']);
      assert.deepEqual(removed.tokens, ['demo-dev']);
    });
  }
});

test('a deployment that cannot write answers 501 rather than pretending', async t => {
  disableAdminScope(t);
  // The harness's default has no writers, which is the deployment shape where the cluster
  // Secret is not writable. A 200 here would tell an operator a cluster was de-registered
  // while it is still in the registry and still being polled.
  await withRouter(async ({ get, registry }) => {
    const res = await get('/clusters/demo-dev/remove', { method: 'POST' });
    assert.equal(res.status, 501);
    assert.equal(res.body.code, 'ONBOARD_DISABLED');
    assert.ok(registry.get('demo-dev'), 'a refused removal must leave the cluster registered');
  });
});

test('an unknown cluster is a 404, not a silent success', async t => {
  disableAdminScope(t);
  const { clusterWriter, tokenWriter } = recordingWriters();
  await withRouter({ clusterWriter, tokenWriter }, async ({ get }) => {
    const res = await get('/clusters/never-onboarded/remove', { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

test('/tokens publishes the two flags the UI gates the control on', async t => {
  disableAdminScope(t);
  // The UI shows the Remove control only when the deployment can write (`canRemove`) and this
  // particular record is deletable (`removable`). Both are computed server-side by the same
  // predicate the handler refuses on, so the control and the refusal cannot disagree.
  const { clusterWriter, tokenWriter } = recordingWriters();

  await withRouter({ clusterWriter, tokenWriter }, async ({ get }) => {
    const res = await get('/tokens');
    assert.equal(res.status, 200);
    assert.equal(res.body.canRemove, true, 'writers present and no admin scope enforced');
    for (const row of res.body.clusters) {
      assert.equal(typeof row.removable, 'boolean', `${row.cluster.id} must state whether it is removable`);
    }
  });

  await withRouter(async ({ get }) => {
    const res = await get('/tokens');
    assert.equal(res.body.canRemove, false, 'no writers means the control must not be offered');
  });
});

test('the /tokens row and the /clusters envelope agree about removability', async t => {
  disableAdminScope(t);
  // Two routes, one predicate. They were three separate copies of the same expression before
  // the control existed, and a UI that reads one while the handler checks another is exactly
  // the drift this pins.
  await withRouter(async ({ get }) => {
    const tokens = await get('/tokens');
    const clusters = await get('/clusters');

    const fromClusters = new Map(clusters.body.clusters.map(c => [c.cluster.id, c.removable]));
    for (const row of tokens.body.clusters) {
      assert.equal(
        row.removable,
        fromClusters.get(row.cluster.id),
        `${row.cluster.id} is described differently by /tokens and /clusters`
      );
    }
  });
});
