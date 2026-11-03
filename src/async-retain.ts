/**
 * The one exception to `useAsync` blanking on a key change, kept pure so it has tests.
 *
 * A changed key normally means a changed subject, and the rows on screen must go. But a key also
 * carries refinements of the same read — a wider log tail, polls shown — and blanking the whole
 * page for those made Traces and Traffic go empty for the length of a cold read (16.9s for Tail →
 * 1000 on platformsbx, 2026-09-27). A caller that names a `subject` keeps its rows while the
 * subject is unchanged, and they are marked stale until the new read lands.
 */
export function keepsDataAcrossKeyChange(prevSubject: string | undefined, nextSubject: string | undefined): boolean {
  return nextSubject !== undefined && prevSubject === nextSubject;
}

/** Rows held from an older key are stale: the page must say so rather than present them as the new read. */
export function isStaleRead(hasData: boolean, dataKey: unknown, key: string | number | null | undefined): boolean {
  return hasData && dataKey !== key;
}

/**
 * The last good read per subject and key, kept for the life of the page.
 *
 * `ClusterDetail` unmounts a tab on every tab switch, and the client caches no responses, so coming
 * back to Traces after the server's 120s window showed the full cold-read skeleton again. A
 * remounted tab seeds from here, marked stale, and re-reads. Keyed by subject (the cluster) as well
 * as key, so one cluster never opens on another's rows; a caller naming no subject keeps nothing.
 */
export function createRetainStore<T>(limit: number) {
  const entries = new Map<string, { value: T; fetchedAt: number }>();
  const id = (subject: string, key: string | number | null | undefined) => JSON.stringify([subject, key ?? null]);
  return {
    get(subject: string | undefined, key: string | number | null | undefined) {
      return subject === undefined ? undefined : entries.get(id(subject, key));
    },
    put(subject: string | undefined, key: string | number | null | undefined, value: T, fetchedAt: number) {
      if (subject === undefined) return;
      const k = id(subject, key);
      // Re-insert so Map order is write order and the first entry is the one to drop.
      entries.delete(k);
      entries.set(k, { value, fetchedAt });
      while (entries.size > limit) entries.delete(entries.keys().next().value as string);
    }
  };
}
