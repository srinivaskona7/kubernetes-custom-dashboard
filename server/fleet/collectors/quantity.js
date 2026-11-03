/**
 * The one place a Kubernetes quantity string becomes a number.
 *
 * Quantities are not numbers and they are not consistently spelled. A memory limit arrives as
 * `4Gi`, `4000Mi`, `4194304k` or `4e9`; a CPU request as `320m`, `2`, or `1500000000n`. Parsing
 * them is easy to get subtly wrong, and a subtle miss here is invisible: it produces a plausible
 * number, not an error.
 *
 * ## Why this module exists
 *
 * It used to be two functions. `collectors/health.js` had a correct one (used by `health.js` and
 * `capacity.js`); `collectors/metrics.js` had a different one, and `collectors/workloads.js` —
 * the payload every resource-usage screen reads — used *that* one. It built its unit table with
 * a capital `K` and no lowercase `k`, then fell back to `parseFloat(s) || 0` when no suffix
 * matched:
 *
 *     const units = { Ki: 1024, ..., K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
 *     for (const [suffix, factor] of Object.entries(units)) { ... }
 *     return parseFloat(s) || 0;
 *
 * **Kubernetes spells the decimal kilo suffix lowercase `k`.** The full set is `n u m "" k M G T
 * P E` decimal and `Ki Mi Gi Ti Pi Ei` binary — so the one suffix Kubernetes writes lowercase was
 * the one that table got wrong, and the fallback turned the miss into a silent 1000x
 * understatement instead of a refusal.
 *
 * Measured on platform-sbx: `calico-typha` declares `limits.memory: 4194304k` (4.19 GB) and was
 * reported as 4194304 bytes (4.19 MB). Against 52 MB of actual usage that is **1249% of the
 * memory limit** for a container sitting at roughly 1.2% of its real one — and not OOMKilled,
 * which is the tell. Six containers on that one cluster were affected, and the cluster's total
 * memory request was understated by ~570 MB.
 *
 * ## Two rules that are not obvious
 *
 * 1. **Split, then look up exactly. Never `endsWith`.** `Ei`/`E`, `Pi`/`P` and `Mi`/`M` are
 *    prefixes of each other, so suffix matching depends on iteration order, which is a bug
 *    waiting for someone to reorder a literal. The regex splits magnitude from unit and the unit
 *    is an exact key.
 * 2. **An unrecognised unit returns `null`, never the bare number.** Treating an unknown suffix
 *    as "no suffix" understates a `Ti` value by twelve orders of magnitude, and reports it with
 *    total confidence. If this module has not been taught a unit, it says so.
 */

/**
 * Every suffix Kubernetes defines, and nothing else.
 *
 * Binary suffixes are powers of 1024; decimal are powers of 1000. `m` (milli) and `M` (mega)
 * differ only by case and by a factor of a billion, which is the strongest possible argument for
 * an exact case-sensitive lookup.
 */
const UNITS = {
  // binary
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  // decimal, sub-unit
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  // decimal
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18
};

/**
 * Magnitude and suffix. Scientific notation is accepted because some clients and CRD status
 * fields emit `128e6`, which is valid JSON number syntax — refusing it produced a wrong answer
 * (a missing value counted as zero) rather than a missing one.
 *
 * The `[eE]` exponent and the `E`/`Ei` suffixes are genuinely ambiguous in the abstract: `1E3`
 * could be 1000 (exponent) or 1 exa (suffix). The regex is greedy on the number, so `1E3` reads
 * as the exponent form — which is what a client emitting scientific notation means, and a
 * quantity of one exabyte spelled `1E` (no digits after) still parses as the suffix form because
 * an exponent needs digits.
 */
const QUANTITY = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;

/**
 * A Kubernetes quantity string as a plain number in base units — bytes for memory, cores for CPU.
 *
 * @param {string|number|null|undefined} q
 * @returns {number|null} `null` when absent, malformed, or carrying a suffix this module does not
 *   define. Never a guess.
 */
function parseQuantity(q) {
  if (q === undefined || q === null || q === '') return null;
  const m = QUANTITY.exec(String(q).trim());
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2];
  if (!unit) return value;
  if (!Object.prototype.hasOwnProperty.call(UNITS, unit)) return null;
  return value * UNITS[unit];
}

/**
 * Bytes, or `null` when unknown.
 *
 * Callers that must have a number use `?? 0`, and they do it at the call site so that the choice
 * to treat "unknown" as zero is visible where it is made rather than buried here.
 *
 * @param {string|number|null|undefined} q
 * @returns {number|null}
 */
function parseMemory(q) {
  return parseQuantity(q);
}

/**
 * Cores, or `0` when unknown.
 *
 * CPU keeps a `0` default rather than `null` because every caller sums CPU across containers and
 * an absent request genuinely is zero cores reserved — unlike memory, where the distinction
 * between "no limit" and "a limit of zero" is the whole point of several columns.
 *
 * @param {string|number|null|undefined} q
 * @returns {number}
 */
function parseCpu(q) {
  const n = parseQuantity(q);
  return n === null ? 0 : n;
}

export default { parseQuantity, parseCpu, parseMemory, UNITS };
