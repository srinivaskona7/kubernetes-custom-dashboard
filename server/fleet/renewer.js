/**
 * In-process token renewal.
 *
 * This replaces the CronJob. The renewal logic itself is unchanged and still lives in
 * renew.js — this file is only the clock.
 *
 * The interval is deliberately much shorter than the renewal window. A pod restart resets
 * any timer, so a process that woke every twelve hours and renewed unconditionally would
 * lose the chain to a redeploy at the wrong moment. Instead it wakes every thirty minutes
 * and renews only what is actually due, which makes the schedule stateless: whatever
 * happened before this process started, the first sweep puts the fleet right.
 *
 * Three properties worth keeping in mind:
 *
 *   - It sweeps once at startup, after a short delay. A pod that has been down for a while
 *     comes back and immediately fixes whatever went stale, rather than waiting.
 *   - Cycles never overlap. A slow or hanging cluster would otherwise let the next tick
 *     start a second sweep, and two concurrent sweeps can mint twice and write twice.
 *   - The timer is unref'd, so it never holds the process open during a shutdown.
 *
 * What is genuinely lost by not having a CronJob: renewal now stops when the application
 * stops. If this pod crash-loops for longer than a token's remaining life, that cluster
 * goes dark and needs a token pasted in. That is the trade, and it is why the SA-token
 * paste path exists — recovering is a paste, not a kubeconfig hunt.
 */
import fleetLog from './log.js';
import renewModule from './renew.js';
const { renewCycle } = renewModule;

/** How often to look. Not how often to renew — renew.js decides that per cluster. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
/**
 * Wait this long after boot before the first sweep. Long enough that the pod is serving
 * traffic and passing its readiness probe first: a sweep across an unreachable fleet can
 * take tens of seconds, and losing a rollout to a slow startup probe would be a poor
 * trade for renewing a token a few seconds sooner.
 */
const DEFAULT_STARTUP_DELAY_MS = 15 * 1000;

class Renewer {
  /**
   * @param {object} deps
   * @param {import('./registry').Registry} deps.registry
   * @param {{readAll: Function, patchAll: Function}} deps.writer
   * @param {number} [deps.intervalMs]
   * @param {number} [deps.startupDelayMs]
   * @param {() => number} [deps.now]
   * @param {Function} [deps.cycleFn] injection seam; the default is the real renewal
   * @param {Function} [deps.setTimer] injection seam for tests; defaults to setTimeout
   * @param {Function} [deps.clearTimer]
   * @param {{log: Function, warn: Function, error: Function}} [deps.logger]
   */
  constructor({
    registry, writer,
    intervalMs = Number(process.env.FLEET_RENEW_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    now = Date.now,
    cycleFn = renewCycle,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = fleetLog
  }) {
    this.registry = registry;
    this.writer = writer;
    this.intervalMs = intervalMs;
    this.startupDelayMs = startupDelayMs;
    this.now = now;
    this.cycleFn = cycleFn;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;

    this._timer = null;
    this._running = false;
    this._stopped = false;
    /** Last outcome, surfaced on /api/fleet/tokens so the UI can show the schedule state. */
    this.last = { at: null, healthy: null, total: null, renewed: 0, error: null };
  }

  /** Begin sweeping. Returns this, so a caller can start and keep a handle in one line. */
  start() {
    this._stopped = false;
    this._arm(this.startupDelayMs);
    this.logger.log(
      `[renew] in-process renewal armed: first sweep in ${Math.round(this.startupDelayMs / 1000)}s, ` +
      `then every ${Math.round(this.intervalMs / 60000)}m`
    );
    return this;
  }

  /** Stop sweeping. A cycle already in flight is allowed to finish. */
  stop() {
    this._stopped = true;
    if (this._timer) {
      this.clearTimer(this._timer);
      this._timer = null;
    }
  }

  _arm(delayMs) {
    if (this._stopped) return;
    this._timer = this.setTimer(() => this._tick(), delayMs);
    // A pending renewal must never be the reason a pod refuses to exit.
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _tick() {
    this._timer = null;
    // `runOnce` is contracted never to throw, and re-arming in `finally` is what keeps that
    // contract from being load-bearing. If it were ever broken — a non-Error rejection makes
    // `err.message` throw from inside its own catch — the rejection would escape here, the
    // timer would never be re-armed, and renewal would stop for the life of the pod with no
    // failing sweep to show for it. Every stored token then expires ~24h later, which reads
    // as the clusters going down rather than as a dead renewer.
    try {
      await this.runOnce();
    } finally {
      this._arm(this.intervalMs);
    }
  }

  /**
   * One sweep. Public because the "Renew now" button and the tests both want exactly this,
   * and because a caller that awaits it gets a deterministic result instead of a timer.
   *
   * Never throws. A renewal failure is a logged, reported condition — throwing here would
   * become an unhandled rejection inside a timer callback, which in Node is a process exit.
   */
  async runOnce() {
    if (this._running) {
      // Not an error. A cluster that hangs for longer than the interval is exactly the
      // situation this guard exists for, and saying so once per tick is enough.
      this.logger.warn('[renew] previous sweep still running; skipping this tick');
      return this.last;
    }
    this._running = true;
    try {
      const result = await this.cycleFn({ registry: this.registry, writer: this.writer, now: this.now() });
      this.last = {
        at: new Date(this.now()).toISOString(),
        healthy: result.healthy,
        total: result.total,
        renewed: result.renewed,
        error: null
      };
      if (result.total === 0) {
        this.logger.log('[renew] no active clusters');
      } else {
        this.logger.log(`[renew] sweep done: ${result.healthy}/${result.total} hold a usable token, ${result.renewed} renewed`);
      }
      for (const broken of result.broken) {
        // Loud, greppable, and it names the fix. This is the line an operator will find.
        this.logger.error(`[renew] ACTION REQUIRED ${broken.cluster}: ${broken.summary}`);
      }
    } catch (err) {
      // Reaching here means the Secret could not be read or written — the whole sweep
      // failed, not one cluster. Every stored token is still whatever it was.
      // Read through a guard rather than off `err` directly: a rejection that is not an
      // Error (a string, null, a bare object) would make `err.message` throw from inside
      // this handler, and the escaping rejection would take the renewal timer with it.
      const message = (err && err.message) || String(err);
      this.last = {
        at: new Date(this.now()).toISOString(),
        healthy: null, total: null, renewed: 0,
        error: message
      };
      this.logger.error(`[renew] sweep FAILED: ${message}`);
    } finally {
      this._running = false;
    }
    return this.last;
  }
}

export default { Renewer, DEFAULT_INTERVAL_MS, DEFAULT_STARTUP_DELAY_MS };
