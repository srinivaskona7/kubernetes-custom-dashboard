/**
 * The rail's cluster selector, minus React.
 *
 * Separated for the same reason `sidebar-width.ts` is: `app/fleet-ui` runs vitest with
 * `environment: 'node'`, so anything that has to be proven — how a name is abbreviated, what a
 * filter matches, when the filter appears at all — has to be reachable without mounting a
 * component.
 *
 * Everything here is a function of the cluster list as it arrives from the API. Nothing is tuned
 * to a particular fleet: the console is expected to run against one cluster or thirty, and a
 * cluster added at runtime appears on the next 30s poll with no other change.
 */

/** Above this many clusters, scanning a list stops being faster than typing three letters. */
export const FILTER_APPEARS_ABOVE = 7;

export interface SwitcherCluster {
  id: string;
  displayName?: string | null;
  env?: string | null;
}

/** What the rail tile shows when there is no room for a name. */
export function abbreviate(cluster: SwitcherCluster): string {
  const source = (cluster.displayName || cluster.id || '').trim();
  if (!source) return '??';
  // Two words give two initials — "Platform Sandbox" reads as PS, which is the thing an operator
  // recognises. A single word gives its first two characters, because "Pl" of "platform-sbx" is
  // still better than "PL" of nothing. Separators are `-`, `_`, `.` and whitespace, which covers
  // both a display name and a generated id.
  const words = source.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * Filter the roster by what the operator typed.
 *
 * Matches the display name, the id and the env, because all three are things someone reaches for:
 * "sbx" is an env, "platform" is a name, and an id is what a deep link carries. Case-insensitive
 * substring, not fuzzy — a fuzzy match on a fleet of near-identical names ("prod-eu", "prod-us")
 * ranks confidently and wrongly, and the cost of being wrong here is opening the wrong cluster.
 */
export function filterClusters<T extends SwitcherCluster>(clusters: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return clusters;
  return clusters.filter(c =>
    [c.displayName, c.id, c.env].some(field => String(field || '').toLowerCase().includes(q))
  );
}

/** Whether the type-to-filter box is worth the row it costs. */
export function showFilter(count: number): boolean {
  return count > FILTER_APPEARS_ABOVE;
}

/**
 * Where the arrow keys go from here.
 *
 * Returns the next index, clamped rather than wrapped: wrapping from the last item to the first
 * in a list long enough to scroll moves the highlight somewhere off-screen, and the operator
 * cannot tell whether the key did nothing or did too much. `-1` means nothing is highlighted yet,
 * and the first ArrowDown lands on the first row.
 */
export function nextIndexForKey(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1);
    case 'ArrowUp':
      return Math.max(0, current <= 0 ? 0 : current - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
