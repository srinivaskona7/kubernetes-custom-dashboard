
/**
 * One pod-log read, shared by `/traffic-errors` and `/traces`.
 *
 * Both routes tail the same `istio-proxy` containers (the ingress gateways first, then the same
 * sidecars by name), and a pod-log read is the slowest call either makes: 3s for one gateway tail
 * against platformsbx, 7-11s when a dozen run at once (measured 2026-09-26). Before this, opening
 * Traces after Traffic tailed every proxy a second time for a window that overlapped almost
 * entirely with the one just read.
 *
 * ## What is shared, and what is not
 *
 * The raw tail of one container, keyed by cluster, credential fingerprint, pod, container and
 * `sinceSeconds`. A caller asking for `n` lines of an entry read at `requested >= n` gets the
 * newest `n` of them, which is the same set a direct `tailLines=n` read returns. A caller asking
 * for more than was read reads again.
 *
 * The credential is in the key for the same reason it is in the k8s list cache: an OIDC cluster
 * reads as the operator, and one operator's tail is not another's to be served.
 *
 * ## Freshness is the caller's call
 *
 * `maxAgeMs` says how old an entry this read will accept. The route passes its own serve bound for
 * an interactive read and `0` for a background refresh or the Refresh control, so a refresh always
 * tails the proxies and never re-serves what it is replacing. Every result carries `at`, the time
 * its bytes were read, and the collectors date their answer by the oldest one.
 *
 * One instance per router: the harness gets a fresh one per test, and nothing module-level
 * outlives it.
 */
import k8sModule from '../k8s.js';
const { tokenFingerprint } = k8sModule;

/** Distinct container tails kept. A tab reads at most a dozen per cluster and window. */
const DEFAULT_MAX_ENTRIES = 200;
/**
 * Bytes of raw tail kept across every entry. One tail can reach the 512 KB read cap, so the entry
 * count alone would let 200 of them pin ~100 MB in a 500 MB pod.
 */
const DEFAULT_MAX_BYTES = 32_000_000;
/**
 * An entry older than this serves nobody (the route passes its own serve bound as `maxAgeMs`), so
 * it is dropped on the next insert. Tails of rotated credentials and deleted pods go with it.
 */
const DEFAULT_RETAIN_MS = 120_000;

/**
 * The newest `n` lines of an entry, shaped like a direct `tailLines=n` read.
 *
 * `n` at or past the entry's own tail returns it whole: that is the refit case, where the byte
 * ceiling already shortened the read below what was asked, and a direct read would be shortened
 * the same way. `byteCapped` carries over unchanged — it is the conservative reading, since it
 * only ever widens `truncated`.
 */
function fitTail(entry, n) {
  if (n >= entry.tail) return { raw: entry.raw, tail: entry.tail, byteCapped: entry.byteCapped };
  if (!entry.raw) return { raw: '', tail: n, byteCapped: entry.byteCapped };
  const kept = entry.raw.replace(/\n$/, '').split('\n').slice(-n);
  return { raw: `${kept.join('\n')}\n`, tail: n, byteCapped: entry.byteCapped };
}

function createLogShare({ now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, retainMs = DEFAULT_RETAIN_MS } = {}) {
  const entries = new Map();
  const inflight = new Map();
  let bytes = 0;

  const drop = key => {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.raw ? entry.raw.length : 0;
    entries.delete(key);
  };

  // Insertion order is read order, so the first key is always the oldest entry.
  const store = (key, entry) => {
    drop(key);
    for (const [k, e] of entries) {
      if (entry.at - e.at <= retainMs) break;
      drop(k);
    }
    entries.set(key, entry);
    bytes += entry.raw ? entry.raw.length : 0;
    while (entries.size > 1 && (entries.size > maxEntries || bytes > maxBytes)) drop(entries.keys().next().value);
  };

  const keyOf = ({ cluster, token }, namespace, pod, container, sinceSeconds) =>
    [cluster && cluster.id, tokenFingerprint(token), namespace, pod, container, sinceSeconds || ''].join('|');

  /**
   * A byte-capped tail kept its oldest bytes (the kubelet cuts `limitBytes` from the front), so it
   * does not end at the newest line. Its last `n` lines are not what `tailLines=n` returns; only a
   * caller wanting at least as many lines as it holds gets the same answer a direct read would.
   */
  const fits = (entry, n) => n <= entry.requested && (!entry.byteCapped || n >= entry.tail);

  const served = (entry, n, shared) => ({ ...fitTail(entry, n), at: entry.at, shared });

  /**
   * @param {object} args
   * @param {{cluster: object, token: string}} args.baseCtx
   * @param {string} args.namespace
   * @param {string} args.pod
   * @param {string} args.container
   * @param {number|null} args.sinceSeconds
   * @param {number} args.tail      lines the caller wants
   * @param {number} args.readTail  lines to read when it has to read (>= tail), so the next caller fits
   * @param {number} args.maxAgeMs  oldest entry this caller accepts; 0 always reads
   * @param {(lines: number) => Promise<{raw: string, tail: number, byteCapped: boolean}>} args.fetch
   */
  async function read({ baseCtx, namespace, pod, container, sinceSeconds, tail, readTail, maxAgeMs, fetch }) {
    const key = keyOf(baseCtx, namespace, pod, container, sinceSeconds);
    const reuse = Number(maxAgeMs) > 0;

    const hit = entries.get(key);
    if (reuse && hit && now() - hit.at <= maxAgeMs && fits(hit, tail)) return served(hit, tail, true);

    const pending = inflight.get(key);
    if (reuse && pending && tail <= pending.requested) {
      const joined = await pending.promise;
      if (fits(joined, tail)) return served(joined, tail, true);
    }

    const requested = Math.max(tail, Number(readTail) || tail);
    // Identity, not the promise: a `fetch` that throws synchronously runs the `finally` below
    // before `promise` is assigned.
    const mine = { requested };
    inflight.set(key, mine);
    const promise = (async () => {
      try {
        const got = await fetch(requested);
        const entry = { at: now(), requested, raw: got.raw, tail: got.tail, byteCapped: got.byteCapped };
        store(key, entry);
        return entry;
      } finally {
        if (inflight.get(key) === mine) inflight.delete(key);
      }
    })();
    mine.promise = promise;
    return served(await promise, tail, false);
  }

  return { read, size: () => entries.size, bytes: () => bytes };
}

export default { createLogShare, fitTail };
