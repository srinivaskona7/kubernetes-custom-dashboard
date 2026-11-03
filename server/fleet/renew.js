/**
 * Renewing a cluster's token.
 *
 * The contract, in one paragraph: for each active cluster, use the token we currently hold
 * to mint its 24h replacement, then patch them all into the Secret in a single write. One
 * cluster's failure never stops the others and never blanks that cluster's existing token —
 * a failed cycle leaves the previous token in place, which is precisely what makes renewing
 * at half-life survivable.
 *
 * Two callers, one implementation:
 *
 *   - renewer.js, the in-process clock, which sweeps every thirty minutes.
 *   - the "Renew now" button, via the same renewCycle for one cluster.
 *
 * If the button and the schedule could drift apart, the button would be a lie: it would
 * report success against a code path the automatic renewal never takes.
 *
 * There is also a `node server/fleet/renew.js` entry point at the bottom. Nothing schedules
 * it — it is break-glass, for running a sweep by hand inside a pod when the application
 * itself will not start.
 */
// Registry and SecretTokenWriter are required lazily in the break-glass block at the
// bottom. Requiring them here would pull a Secret reader and a filesystem scan into every
// caller of renewOne, including the tests.
import fleetLog from './log.js';
import { fileURLToPath } from 'node:url';
import mintModule from './mint.js';
const { mint } = mintModule;
import errorsModule from './errors.js';
const { ClusterError } = errorsModule;
import registryModule from './registry.js';
const { Registry } = registryModule;
import secretWriterModule from './secret-writer.js';
const { SecretTokenWriter } = secretWriterModule;

/** Renew when a token has less than this left. Half of a 24h lifetime. */
const RENEW_BELOW_MS = 12 * 60 * 60 * 1000;

/**
 * One sweep across the fleet.
 *
 * @param {object} args
 * @param {import('./registry').Registry} args.registry
 * @param {{readAll: Function, patchAll: Function}} args.writer
 * @param {number} [args.now]
 * @param {typeof renewOne} [args.renewFn] injection seam
 * @param {{log: Function}} [args.logger]
 * @returns {Promise<{total: number, healthy: number, renewed: number,
 *                    broken: object[], report: object[]}>}
 */
async function renewCycle({ registry, writer, now = Date.now(), renewFn = renewOne, logger = fleetLog }) {
  const stored = await writer.readAll();
  const clusters = registry.active();

  const patches = {};
  const report = [];

  // Sequential rather than concurrent. This runs against a handful of clusters, so there
  // is nothing to gain from parallelism, and a serial log is far easier to read at 3am
  // than interleaved output from five clusters.
  for (const cluster of clusters) {
    const outcome = await renewFn({ cluster, record: stored[cluster.id], now });
    report.push(outcome);
    if (outcome.patch) patches[cluster.id] = outcome.patch;
    logger.log(`[renew] ${cluster.id}: ${outcome.summary}`);
  }

  if (Object.keys(patches).length > 0) {
    // One write for the whole fleet. A strategic merge patch touches only these keys, so
    // clusters that failed keep whatever they had.
    await writer.patchAll(patches);
  }

  return {
    total: report.length,
    healthy: report.filter(r => r.healthy).length,
    // Counted from an explicit flag set only by the branch that actually minted. It used to
    // be inferred from `patch.renewedAt`, which is wrong: a failed renewal patches the old
    // record back with an error attached, and the old record carries the *previous*
    // renewedAt — so every failure was reported as a renewal.
    renewed: report.filter(r => r.renewed).length,
    broken: report.filter(r => !r.healthy),
    report
  };
}

/**
 * @param {object} args
 * @param {object} args.cluster
 * @param {object|null} args.record  what the Secret currently holds for this cluster
 * @param {number} args.now
 * @param {typeof mint} [args.mintFn] injection seam; the default is the real thing
 * @returns {{cluster: string, healthy: boolean, renewed: boolean, summary: string,
 *            patch: object|null}}
 */
async function renewOne({ cluster, record, now, mintFn = mint }) {
  const id = cluster.id;

  if (!record || !record.token) {
    return {
      cluster: id, healthy: false, renewed: false, patch: null,
      summary: `never seeded — run: kubectl create token ${cluster.serviceAccount} -n ${cluster.namespace} --duration=24h`
    };
  }

  const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
  const remaining = Number.isNaN(expiresAt) ? null : expiresAt - now;

  if (remaining !== null && remaining <= 0) {
    // Both the token and its renewal window have lapsed. The chain cannot recover on its
    // own — minting requires a valid token, and there isn't one.
    return {
      cluster: id, healthy: false, renewed: false,
      patch: { ...record, lastError: `expired at ${record.expiresAt}; re-seed required` },
      summary: `EXPIRED at ${record.expiresAt} — chain broken, re-seed by hand`
    };
  }

  if (remaining !== null && remaining > RENEW_BELOW_MS) {
    return {
      cluster: id, healthy: true, renewed: false, patch: null,
      summary: `still valid for ${humanise(remaining)}, no renewal needed`
    };
  }

  try {
    const minted = await mintFn({ cluster, currentToken: record.token });
    const life = Date.parse(minted.expiresAt) - now;
    // Trust the server's expiry. If a cluster ever grants less than asked, this is where
    // it becomes visible instead of causing a silent gap twelve hours later.
    const short = life < RENEW_BELOW_MS
      ? ` WARNING: granted only ${humanise(life)}, shorter than the ${humanise(RENEW_BELOW_MS)} renewal interval`
      : '';
    return {
      cluster: id, healthy: true, renewed: true,
      patch: { token: minted.token, expiresAt: minted.expiresAt, renewedAt: new Date(now).toISOString(), lastError: null },
      summary: `renewed, expires ${minted.expiresAt}${short}`
    };
  } catch (err) {
    const code = err instanceof ClusterError ? err.code : 'UPSTREAM';
    // Keep the old token: it may still have hours left, and this may be a transient
    // network failure. Record the error so the UI can show why.
    const stillUsable = remaining !== null && remaining > 0;
    return {
      cluster: id,
      healthy: stillUsable,
      renewed: false,
      patch: { ...record, lastError: `${code}: ${err.message}` },
      summary: stillUsable
        ? `renewal FAILED (${code}: ${err.message}) — previous token still valid for ${humanise(remaining)}, will retry next cycle`
        : `renewal FAILED (${code}: ${err.message}) — no usable token remains`
    };
  }
}

function humanise(ms) {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Break-glass: run one sweep by hand. Nothing schedules this.
//
//   kubectl exec deploy/<release> -- node server/fleet/renew.js
//
// Exits 0 whenever at least one cluster still holds a usable token, and 1 when every
// cluster is broken — so a human running it gets a verdict, not just a log.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  renewCycle({ registry: new Registry(), writer: new SecretTokenWriter() })
    .then(result => {
      console.log(`[renew] ${result.healthy}/${result.total} cluster(s) hold a usable token, ${result.renewed} renewed`);
      for (const b of result.broken) console.error(`[renew] ACTION REQUIRED ${b.cluster}: ${b.summary}`);
      if (result.total > 0 && result.healthy === 0) {
        console.error('[renew] every cluster is broken');
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('[renew] fatal:', err);
      process.exit(1);
    });
}

export default { renewCycle, renewOne, RENEW_BELOW_MS, humanise };
