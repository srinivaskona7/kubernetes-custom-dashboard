/**
 * The namespace filter's logic, with no JSX, so it can be tested.
 *
 * `app/fleet-ui` runs vitest with `environment: 'node'` — jsdom cannot be installed on this
 * workstation (npm E401 against the internal registry). So anything that needs a test has to be
 * separable from its markup, and this is the separable half: which namespaces exist, which rows a
 * selection admits, and what the toolbar should say about it. `NamespaceFilter.tsx` renders these
 * answers and holds no rules of its own.
 *
 * ## The empty set means "all", and that is deliberate
 *
 * A selection of zero namespaces could equally mean "show nothing", and a filter that starts by
 * hiding every row would read as a broken page. Every predicate here treats an empty selection as
 * unfiltered, which makes the default state — requirement 3, "All Namespaces" — the *same* state as
 * "the user cleared the filter". One state, so the two can never disagree.
 *
 * ## Namespaces come from the rows, never from a list
 *
 * `namespacesOf` derives the options from the data actually on screen. A hardcoded list goes stale
 * the first time a team creates a namespace, and — worse on this console — a list that includes a
 * namespace with no rows offers a filter that produces an empty table, which reads as a failed read
 * rather than as an empty selection.
 */

/**
 * The distinct namespaces present in `rows`, sorted.
 *
 * Cluster-scoped objects have no namespace, and they are **not** given a placeholder bucket here:
 * `null` is excluded from the options because a filter chip reading "—" cannot be understood. Callers
 * that show cluster-scoped rows keep them visible under any selection — see {@link matchesNamespace}.
 */
export function namespacesOf<T>(rows: readonly T[], of: (row: T) => string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const ns = of(row);
    if (typeof ns === 'string' && ns.length > 0) seen.add(ns);
  }
  // Plain locale sort. Grouping system namespaces last was considered and rejected: "system" is not a
  // property Kubernetes records, so any such grouping is this console guessing from name prefixes —
  // and `kyma-system` vs `applecare` is exactly the guess an operator would have to un-learn.
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Whether a row survives the selection. OR semantics across namespaces (requirement 9).
 *
 * A row with no namespace is **always shown**. It is cluster-scoped: it does not belong to any
 * namespace, so no namespace selection can exclude it, and hiding it would mean a namespace filter
 * silently removed ClusterRoles and Nodes from a table that also lists them.
 */
export function matchesNamespace(ns: string | null | undefined, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  if (typeof ns !== 'string' || ns.length === 0) return true;
  return selected.has(ns);
}

/** The options a search narrows to. Case-insensitive substring, because namespaces are lowercase-ish. */
export function searchNamespaces(all: readonly string[], search: string): string[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...all];
  return all.filter(ns => ns.toLowerCase().includes(needle));
}

/**
 * Add or remove one namespace, returning a new Set.
 *
 * A new Set rather than a mutation: React state compared by identity will not re-render on a mutated
 * Set, which is the shape that produces a filter whose first click does nothing.
 */
export function toggleNamespace(selected: ReadonlySet<string>, ns: string): Set<string> {
  const next = new Set(selected);
  if (next.has(ns)) next.delete(ns);
  else next.add(ns);
  return next;
}

/**
 * Drop any selected namespace that is no longer among the options.
 *
 * Called when the underlying rows change — a different cluster, a different resource type, a
 * re-read that no longer includes a namespace. Without this, a stale selection filters every row
 * away and the table reads as empty for a reason nothing on screen explains.
 *
 * Returns the same Set instance when nothing changed, so a caller can use it in a `useMemo` without
 * causing a render loop.
 */
export function pruneNamespaces(selected: ReadonlySet<string>, options: readonly string[]): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const allowed = new Set(options);
  let dropped = false;
  for (const ns of selected) {
    if (!allowed.has(ns)) {
      dropped = true;
      break;
    }
  }
  if (!dropped) return selected;
  return new Set([...selected].filter(ns => allowed.has(ns)));
}

/**
 * What the toolbar control says (requirement 13: the active filter must be clear).
 *
 * One selected namespace is named in full, because the name *is* the answer and "1 namespace" would
 * make the operator open the menu to find out which. Two or more are counted, because three long
 * namespace names do not fit a toolbar button and a truncated list is worse than a count.
 */
export function namespaceLabel(selected: ReadonlySet<string>): string {
  if (selected.size === 0) return 'All namespaces';
  if (selected.size === 1) return [...selected][0] as string;
  return `${selected.size} namespaces`;
}

/**
 * The full selection, for the control's tooltip and for a screen reader.
 *
 * Every selected name, in sort order — so the count in {@link namespaceLabel} always has somewhere
 * to resolve to without opening the menu.
 */
export function namespaceTitle(selected: ReadonlySet<string>, optionCount: number): string {
  if (selected.size === 0) {
    return optionCount === 0
      ? 'No namespace appears in these rows, so there is nothing to filter by.'
      : `Showing every namespace. ${optionCount} appear${optionCount === 1 ? 's' : ''} in these rows.`;
  }
  const names = [...selected].sort((a, b) => a.localeCompare(b)).join(', ');
  return `Showing ${selected.size} of ${optionCount} namespaces: ${names}. Cluster-scoped rows, which belong to no namespace, stay visible.`;
}

/**
 * The count line beside the filter (requirement 10: visible counts update after filtering).
 *
 * Says "of" rather than printing a bare number, because a count that shrank silently is
 * indistinguishable from a read that returned less — the failure mode this console exists to avoid.
 */
export function resultLine(shown: number, total: number, noun: string): string {
  if (shown === total) return `${total.toLocaleString()} ${noun}`;
  return `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`;
}
