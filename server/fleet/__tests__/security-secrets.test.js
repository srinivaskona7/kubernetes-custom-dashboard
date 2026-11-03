/**
 * Secret counting in the Security collector.
 *
 * This page reports how many Secrets exist and how they break down by type, and it now gets
 * both without fetching a single Secret body: a metadata-only list for the total, and one
 * server-side field-selector count per type. That change is worth guarding from two
 * directions, because it can regress in two very different ways.
 *
 *  - **Silently expensive and unsafe again.** Drop the `Accept` override and every read goes
 *    back to full objects — 1.2 MB of `data:` blocks into the process for a count. Nothing
 *    fails; the numbers stay right. Only a test that asserts on the header notices.
 *  - **Silently wrong.** A denied or truncated count must not become a zero, and `other` is a
 *    subtraction, so one bad bucket poisons it. Reporting "3 Secrets of an unknown type" when
 *    the truth is "one count was refused" is the exact failure the completeness contract
 *    exists to prevent.
 *
 * Every list is an injected double; no test opens a socket.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _security from '../collectors/security.js';
const { collect } = _security;
import _k8s2 from '../k8s.js';
const { METADATA_ONLY } = _k8s2;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

/** A Secret as the metadata-only endpoint returns it: metadata, and deliberately no `type`. */
const secretMeta = (name, namespace = 'default') => ({ metadata: { name, namespace } });

function typeOf(path) {
  const m = /fieldSelector=type%3D([^&]+)/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * A cluster whose Secrets are `counts` by type, answering the way the apiserver does:
 * `?fieldSelector=type=X` returns only that type, and the unfiltered list returns all of
 * them. `extra` adds Secrets of types the collector does not count by name, which is what
 * the `other` bucket is for.
 */
function secretCluster(counts, { extra = 0, fail = null, truncate = null } = {}) {
  const seen = [];
  const listFn = async ({ path, accept }) => {
    seen.push({ path, accept });
    if (!path.startsWith('/api/v1/secrets')) return [];

    const t = typeOf(path);
    if (fail && fail === t) {
      const err = new Error('secrets is forbidden');
      err.status = 403;
      throw err;
    }
    const make = n => Array.from({ length: n }, (_, i) => secretMeta(`${t || 'all'}-${i}`));

    if (t !== null) {
      const out = make(counts[t] || 0);
      if (truncate === t) Object.defineProperty(out, 'truncated', { value: true });
      return out;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0) + extra;
    const out = make(total);
    if (truncate === '*') Object.defineProperty(out, 'truncated', { value: true });
    return out;
  };
  return { listFn, seen };
}

const run = ({ listFn }) => collect({ cluster, token: 't', listFn });

test('the type breakdown matches the per-type counts, and the total is the metadata list', async () => {
  const c = secretCluster({ Opaque: 78, 'kubernetes.io/tls': 21, 'helm.sh/release.v1': 56 });
  const out = await run(c);

  assert.equal(out.summary.totalSecretsCount, 155);
  assert.deepEqual(out.secretTypeDistribution, {
    Opaque: 78, 'kubernetes.io/tls': 21, 'helm.sh/release.v1': 56
  });
  assert.equal(out.secretTypeDistributionComplete, true);
  // A type with a real zero is a successful read, not a missing one — but an empty bucket is
  // noise on the page, so it is counted and then not shown.
  assert.ok(!('kubernetes.io/ssh-auth' in out.secretTypeDistribution));
});

test('Secrets of an uncounted type land in `other` rather than disappearing', async () => {
  // Measured live: platformsbx had one `istio.io/ca-root` outside the named set, and the
  // named counts summed to one less than the total. The wrong answer is to drop it, which
  // makes the breakdown quietly not add up to the number printed beside it.
  const c = secretCluster({ Opaque: 10 }, { extra: 3 });
  const out = await run(c);
  assert.equal(out.summary.totalSecretsCount, 13);
  assert.equal(out.secretTypeDistribution.other, 3);
  assert.equal(out.secretTypeDistributionComplete, true);
});

test('no Secret body is ever fetched — every count is a metadata-only read', async () => {
  // The security half of the change, and the half that can regress without any test noticing:
  // full objects return the right counts too. 1.2 MB of `data:` blocks entering the process
  // to be counted and discarded is the thing being prevented, so the header is asserted
  // directly. Canaried — dropping `accept` from the collector fails this.
  const c = secretCluster({ Opaque: 2 });
  await run(c);
  const secretReads = c.seen.filter(r => r.path.startsWith('/api/v1/secrets'));
  assert.ok(secretReads.length > 1, 'the total and the per-type counts are separate reads');
  for (const r of secretReads) {
    assert.equal(r.accept, METADATA_ONLY, `${r.path} must not fetch Secret bodies`);
  }
});

test('a refused type count is omitted, never reported as zero', async () => {
  // An absent key means "not known"; a 0 would mean "none exist". The wrong answer here is
  // `Opaque: 0` on a cluster full of Opaque Secrets.
  const c = secretCluster({ Opaque: 40, 'kubernetes.io/tls': 2 }, { fail: 'Opaque' });
  const out = await run(c);

  assert.ok(!('Opaque' in out.secretTypeDistribution), 'a refused count must not become a zero');
  assert.equal(out.secretTypeDistribution['kubernetes.io/tls'], 2, 'the counts that did arrive are real');
  assert.equal(out.secretTypeDistributionComplete, false);
  assert.ok(
    out.summary.unavailable.includes('secrets[type=Opaque]'),
    'the refused bucket must be named, so the gap is visible rather than implied'
  );
});

test('`other` is withheld when any count failed, because it is a subtraction', async () => {
  // total 42, Opaque refused, tls 2 counted => a naive remainder is 40 "other" Secrets, which
  // is a confident invention. The right answer is no `other` key at all.
  const c = secretCluster({ Opaque: 40, 'kubernetes.io/tls': 2 }, { fail: 'Opaque' });
  const out = await run(c);
  assert.ok(!('other' in out.secretTypeDistribution), 'one failed bucket must not become an `other` count');
  assert.equal(out.summary.totalSecretsCount, 42, 'the total itself is still known and still reported');
});

test('a truncated type count is treated as unknown, not as its partial value', async () => {
  const c = secretCluster({ Opaque: 5 }, { truncate: 'Opaque' });
  const out = await run(c);
  assert.ok(!('Opaque' in out.secretTypeDistribution), 'a count cut short at the ceiling is a floor, not a count');
  assert.equal(out.secretTypeDistributionComplete, false);
  assert.ok(out.summary.truncated.includes('secrets[type=Opaque]'));
});

test('a denial on Secrets reports one label, not eleven saying the same thing', async () => {
  // A 403 on Secrets refuses the total and all ten type counts at once. Naming every bucket
  // beside the parent turns one missing fact into eleven rows of noise; the parent label
  // already says the section is unknown.
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/secrets')) {
      const err = new Error('secrets is forbidden');
      err.status = 403;
      throw err;
    }
    return [];
  };
  const out = await collect({ cluster, token: 't', listFn });
  const secretLabels = out.summary.unavailable.filter(l => l.startsWith('secrets'));
  assert.deepEqual(secretLabels, ['secrets']);
  assert.equal(out.secretTypeDistributionComplete, false);
  assert.deepEqual(out.secretTypeDistribution, {}, 'nothing is claimed about a section that was refused');
});
