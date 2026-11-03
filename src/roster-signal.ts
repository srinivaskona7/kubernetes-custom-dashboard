/**
 * A one-number signal that the set of registered clusters has changed.
 *
 * The sidebar rail reads the roster on its own 30-second poll, which is right for *health* — a
 * node going NotReady can wait a few seconds. It is wrong for *membership*: onboarding a cluster
 * and removing one both change which entries exist, and until the next tick lands the rail keeps
 * listing a cluster the server has already forgotten, or omits one that was just added. Measured
 * at up to 30s of a ghost row after a removal.
 *
 * Deliberately not the existing `refreshedAt` timestamp the shell already threads down. That
 * changes on every successful read anywhere in the console — several times a minute on a page
 * that is merely polling — so keying the rail's fetch on it would double the roster reads to fix
 * an event that happens twice an hour. This fires only when membership actually changed.
 *
 * A counter rather than a timestamp: two removals inside the same millisecond are two events, and
 * `Date.now()` would collapse them into one no-op.
 */
import { useSyncExternalStore } from 'react';

let version = 0;
const listeners = new Set<() => void>();

/** Call after a cluster is onboarded or de-registered — never on a plain re-read. */
export function rosterChanged(): void {
  version += 1;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function snapshot(): number {
  return version;
}

/**
 * The current roster version, suitable as the `key` argument to `useAsync` — a change forces the
 * fetcher to re-run immediately rather than waiting out the poll interval.
 */
export function useRosterVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
