/**
 * The container lists behind the Security posture counts.
 *
 * The page has always printed "9 Privileged" and "71 / 147 non-root" and offered no way to find
 * out *which* containers those are — a number an operator cannot act on. The two lists added
 * beside those counts fix that, and they can go wrong in three ways that no green deploy shows:
 *
 *  - **The list and the count disagree.** The non-root rule has three clauses, and the pod-level
 *    `runAsNonRoot` is the one a re-implementation forgets. A list built from its own copy of the
 *    rule then names containers the number beside it considers fine, and nothing says which of
 *    the two is lying. Hence one shared predicate, and hence the test below that puts an empty
 *    container securityContext inside a pod-level `runAsNonRoot: true` pod.
 *  - **The cap shrinks the count.** The lists are capped, the counts are not. Capping both would
 *    turn "there are 400 root-capable containers, here are 200 of them" into the quieter and
 *    wrong "there are 200".
 *  - **The list leaks.** These rows are built by walking full pod specs, which carry env vars,
 *    image pull secrets and every securityContext field. Only three names are wanted, so the
 *    key set is asserted exactly: a future edit that helpfully adds `image` or `env` fails here
 *    rather than shipping cluster configuration into a browser.
 *
 * Every list is an injected double; no test opens a socket.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _security from '../collectors/security.js';
const { collect, CONTAINER_LIST_CAP } = _security;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

/**
 * A pod as `/api/v1/pods` returns it, with the noise a real one carries. `image` and `env` are
 * present on purpose: they are what must NOT come out the other end.
 */
function pod(namespace, name, containers, podSecurityContext) {
  return {
    metadata: { namespace, name, labels: {} },
    spec: {
      securityContext: podSecurityContext,
      imagePullSecrets: [{ name: 'regcred' }],
      containers: containers.map(c => ({
        image: 'registry.example/app:1.2.3',
        env: [{ name: 'DB_PASSWORD', value: 'hunter2' }],
        ...c
      }))
    }
  };
}

/** A cluster whose only non-empty read is the pod list. */
const podCluster = pods => async ({ path }) => (path.startsWith('/api/v1/pods') ? pods : []);

const run = listFn => collect({ cluster, token: 't', listFn });

test('a privileged container is named, with its three identifiers and nothing else', async () => {
  const out = await run(podCluster([
    pod('kube-system', 'node-agent', [{ name: 'agent', securityContext: { privileged: true } }]),
    pod('shop', 'web', [{ name: 'app', securityContext: { runAsUser: 1000 } }])
  ]));

  assert.deepEqual(out.privilegedContainerList, [
    { namespace: 'kube-system', pod: 'node-agent', container: 'agent' }
  ]);
  // Exactly these keys. The fixture's containers carry an image and a password-shaped env var,
  // so a spread of the container object into the row would be caught right here.
  assert.deepEqual(Object.keys(out.privilegedContainerList[0]).sort(), ['container', 'namespace', 'pod']);
});

test('a pod-level runAsNonRoot keeps a container out of the root-capable list', async () => {
  // The shared-predicate case. The container's own securityContext is empty, so a list that
  // only looked at `c.securityContext` would call this root-capable — while the count beside
  // it, which does read the pod level, would not. One of the two would be wrong on screen.
  const out = await run(podCluster([
    pod('shop', 'api', [{ name: 'api' }], { runAsNonRoot: true })
  ]));

  assert.equal(out.summary.nonRootContainers, 1);
  assert.deepEqual(out.rootCapableContainerList, []);
});

test('runAsUser 0 is root-capable; runAsUser 1000 is not', async () => {
  // `runAsUser: 0` is not "unspecified", it is an explicit request to be root, and the
  // predicate's `> 0` is what distinguishes the two.
  const out = await run(podCluster([
    pod('shop', 'root-pod', [{ name: 'c', securityContext: { runAsUser: 0 } }]),
    pod('shop', 'user-pod', [{ name: 'c', securityContext: { runAsUser: 1000 } }])
  ]));

  assert.deepEqual(out.rootCapableContainerList, [
    { namespace: 'shop', pod: 'root-pod', container: 'c' }
  ]);
  assert.equal(out.summary.nonRootContainers, 1);
  assert.equal(out.summary.totalContainers, 2);
});

test('both lists agree with the counts on the same payload', async () => {
  // The arithmetic the page presents: the privileged list *is* the privileged count, and the
  // root-capable list is the complement of the non-root count. Below the cap the two are
  // identities, not approximations, and an operator comparing a number to a row count must
  // never find a gap.
  const out = await run(podCluster([
    pod('a-ns', 'p2', [
      { name: 'b', securityContext: { privileged: true } },
      { name: 'a', securityContext: { runAsNonRoot: true } }
    ]),
    pod('a-ns', 'p1', [{ name: 'only', securityContext: { privileged: true, runAsUser: 0 } }]),
    pod('z-ns', 'p3', [{ name: 'sidecar' }], { runAsNonRoot: true })
  ]));

  assert.equal(out.privilegedContainerList.length, out.summary.privilegedContainers);
  assert.equal(
    out.rootCapableContainerList.length,
    out.summary.totalContainers - out.summary.nonRootContainers
  );
  // Stable order between polls, so a row does not move under a cursor on the next refresh.
  assert.deepEqual(out.privilegedContainerList, [
    { namespace: 'a-ns', pod: 'p1', container: 'only' },
    { namespace: 'a-ns', pod: 'p2', container: 'b' }
  ]);
  assert.deepEqual(out.summary.truncated, [], 'nothing was cut short here');
});

test('a capped list is reported as truncated and leaves the count at its true total', async () => {
  const over = CONTAINER_LIST_CAP + 37;
  const pods = Array.from({ length: over }, (_, i) =>
    // Zero-padded so lexicographic order is numeric order; the point of the fixture is the cap,
    // not a sort surprise.
    pod('shop', `p${String(i).padStart(4, '0')}`, [{ name: 'c', securityContext: { privileged: true } }])
  );
  const out = await run(podCluster(pods));

  assert.equal(out.privilegedContainerList.length, CONTAINER_LIST_CAP, 'the list stops at the cap');
  assert.equal(out.summary.privilegedContainers, over, 'the count is the true total, never the cap');
  // Privileged containers are root-capable too here (no runAs* set), so both lists cap.
  assert.equal(out.rootCapableContainerList.length, CONTAINER_LIST_CAP);
  assert.equal(out.summary.totalContainers - out.summary.nonRootContainers, over);
  // Same channel as every other short read: truncated means "these are real but there are
  // more", which is a different claim from `unavailable`.
  assert.ok(out.summary.truncated.includes('containers[privileged]'));
  assert.ok(out.summary.truncated.includes('containers[root-capable]'));
  assert.deepEqual(
    out.summary.unavailable.filter(l => l.startsWith('containers')), [],
    'a capped list is not a failed read'
  );
});

test('no entry in either list carries a field beyond the three names', async () => {
  // Restated as a sweep over both lists, because the leak this guards against would arrive as
  // one extra key added in one place and copied to the other.
  const out = await run(podCluster([
    pod('shop', 'web', [
      { name: 'app', securityContext: { privileged: true, runAsUser: 0, capabilities: { add: ['SYS_ADMIN'] } } },
      { name: 'proxy' }
    ])
  ]));

  const entries = [...out.privilegedContainerList, ...out.rootCapableContainerList];
  assert.ok(entries.length >= 3, 'the fixture produced rows in both lists');
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).sort(), ['container', 'namespace', 'pod'],
      `${JSON.stringify(entry)} must carry object names only`
    );
  }
});
