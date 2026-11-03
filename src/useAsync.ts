/**
 * Data loading. A deliberately small hook rather than a query library: the whole app has
 * seven endpoints, the server already caches for 30s, and a dependency whose job is
 * caching would duplicate that badly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { createRetainStore, isStaleRead, keepsDataAcrossKeyChange } from './async-retain';

/** Last good reads of subject-naming callers, so a remounted tab opens on rows, not a skeleton. */
const retained = createRetainStore<unknown>(12);
/** Stamps seeded rows: they match no key, so `stale` holds until this mount's own read lands. */
const SEEDED = Symbol('seeded');

export interface Async<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True only on the very first load, so a refresh does not blank the page. */
  initial: boolean;
  reload: () => void;
  /**
   * When `data` was last successfully refreshed, or null before the first success ever
   * lands. Kept alive across a failed refetch — same "last good data" contract as `data`
   * itself — so a caller can tell staleness apart from freshness: `Date.now() - fetchedAt`
   * past some multiple of the poll interval means what's on screen predates the last
   * several attempts, not just the most recent one.
   */
  fetchedAt: number | null;
  /**
   * How many refetches in a row have failed since the last success. Reset to 0 the moment
   * one succeeds; incremented on every failure including the very first load's. A page
   * greys out a sidebar dot after this crosses 2 — that decision is the caller's, not this
   * hook's, which only has to keep the count honest.
   */
  consecutiveFailures: number;
  /**
   * True while `data` belongs to an earlier key of the same `subject` (see the `subject` option):
   * the rows are the previous read, kept on screen while the new one runs. Always false for a
   * caller that names no subject, because such a caller never keeps rows across a key change.
   */
  stale: boolean;
}

export interface AsyncOptions {
  /**
   * What the rows are *about* — usually the cluster id. A key change under the same subject (a
   * wider tail, polls shown) keeps the previous rows, marked `stale`, instead of blanking the
   * page; a subject change drops them as any key change does. See `async-retain.ts`.
   */
  subject?: string;
}

/**
 * @param fetcher must be stable — wrap it in useCallback at the call site.
 * @param pollMs  0 disables polling.
 * @param key     changes to this value refetch immediately. Use it when the fetcher closes
 *                over a *selection* (a namespace, a pod, a container) rather than being fixed
 *                for the life of the component: without it the first load is the only load and
 *                the screen sits on the previous selection's data until something calls
 *                `reload()` by hand. It is a primitive on purpose — depending on the fetcher
 *                itself would refetch on every render, since callers routinely build one from
 *                an object identity that `Array.prototype.find` re-creates each time.
 */
export function useAsync<T>(fetcher: () => Promise<T>, pollMs = 0, key?: string | number | null, options: AsyncOptions = {}): Async<T> {
  const [seed] = useState(() => retained.get(options.subject, key) as { value: T; fetchedAt: number } | undefined);
  const [data, setData] = useState<T | null>(seed ? seed.value : null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [initial, setInitial] = useState(!seed);
  const [fetchedAt, setFetchedAt] = useState<number | null>(seed ? seed.fetchedAt : null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  /**
   * Which run owns the screen. Every call takes the next number and only the holder of the
   * current one is allowed to write state, so a slow read is discarded the moment a newer
   * one starts — whether that came from a key change, a `reload()`, or a poll tick landing
   * on top of a sweep that has not come back yet.
   *
   * A single `alive` boolean cannot express this, which was the bug it replaced. React runs
   * cleanup-then-effect on a key change, so `alive = false` was immediately followed by
   * `alive = true`, and the *previous* namespace's in-flight response sailed through the
   * guard and overwrote the namespace the operator had just selected. Silent, and wrong in
   * the one direction an operations console must never be wrong: the page named one subject
   * while showing another's rows.
   */
  const runId = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const lastKey = useRef(key);
  const lastSubject = useRef(options.subject);
  /** The key the run in flight was started for, so its rows are stamped with it. */
  const keyRef = useRef(key);
  keyRef.current = key;
  const subjectRef = useRef(options.subject);
  subjectRef.current = options.subject;
  const [dataKey, setDataKey] = useState<unknown>(seed ? SEEDED : key);

  const run = useCallback(async () => {
    const myRun = ++runId.current;
    const runKey = keyRef.current;
    const runSubject = subjectRef.current;
    const current = () => myRun === runId.current;
    setLoading(true);
    try {
      const value = await fetcherRef.current();
      if (!current()) return;
      const now = Date.now();
      setData(value);
      setDataKey(runKey);
      setError(null);
      setFetchedAt(now);
      retained.put(runSubject, runKey, value, now);
      setConsecutiveFailures(0);
    } catch (err) {
      if (!current()) return;
      // Keep the last good data on screen. A dashboard that blanks on a transient error
      // is strictly worse than one showing data that is thirty seconds stale and says so.
      // `fetchedAt` is deliberately left untouched here too — it names when the data on
      // screen was actually true, not when the last attempt (successful or not) happened.
      setError(err instanceof ApiError ? err : new ApiError(String(err), 'UNKNOWN', 0));
      setConsecutiveFailures(n => n + 1);
    } finally {
      // Superseded runs must not clear `initial` either: doing so tore the skeleton away
      // from the new selection and showed it the previous one's rows as though they were
      // loaded.
      if (current()) {
        setLoading(false);
        setInitial(false);
      }
    }
  }, []);

  useEffect(() => {
    // Keeping the last good data through a *failed refetch* is the point of this hook. Keeping
    // it through a changed `key` is a different thing entirely: the key changing means the
    // subject changed — another cluster, another namespace, another pod — and the rows on
    // screen now describe something the caller is no longer asking about. So on a key change
    // (never on the first run) the data is dropped and `initial` goes back to true, which is
    // what makes the page render its skeleton instead of the previous subject's numbers.
    if (lastKey.current !== key) {
      lastKey.current = key;
      const keep = keepsDataAcrossKeyChange(lastSubject.current, options.subject);
      lastSubject.current = options.subject;
      // The previous key's error says nothing about the new one.
      setError(null);
      const held = keep ? undefined : (retained.get(options.subject, key) as { value: T; fetchedAt: number } | undefined);
      if (held) {
        // Another cluster, but one this page has read before: open on its own last rows, stale.
        setData(held.value);
        setDataKey(SEEDED);
        setFetchedAt(held.fetchedAt);
      } else if (!keep) {
        setData(null);
        setFetchedAt(null);
        setInitial(true);
      }
    }
    void run();
    return () => {
      // Retire the in-flight run rather than flagging the hook dead. On unmount this
      // discards it; on a key change the effect that follows immediately starts its own,
      // and the number it takes is what keeps this one from writing.
      runId.current += 1;
    };
    // `key` belongs here: it is how a caller says "the selection moved, read it again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, key]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => {
      // Polling a hidden tab burns a full fleet sweep every interval for nobody.
      if (document.visibilityState === 'visible') void run();
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs, run]);

  return { data, error, loading, initial, reload: run, fetchedAt, consecutiveFailures, stale: isStaleRead(data !== null, dataKey, key) };
}
