/**
 * The namespace selection, held in the URL rather than in component state.
 *
 * ## Why the URL and not `useState`
 *
 * `WorkloadsArea` renders the workloads table with `key={section}` (`ClusterDetail.tsx`), which
 * force-remounts it when the operator moves between the Workloads and Pods sub-tabs — the two are
 * one renderer with two entrances. Any selection held in `useState` inside that subtree is
 * therefore *silently discarded* on that switch: you filter to `acme-shop`, click Pods, and get
 * every pod on the cluster back with the toolbar claiming nothing is filtered. The URL survives the
 * remount, the reload, and the Back button, and it makes a filtered view something an operator can
 * paste to a colleague.
 *
 * ## Why this is not `useSection`
 *
 * `useSection`/`useUrlSection` in `SubTabs.tsx` validate the URL value against a **fixed list of
 * ids** and fall back when it does not match. A namespace set is neither fixed nor single-valued,
 * so it needs its own parse and its own staleness rule — see {@link parseNamespaceParam}.
 *
 * The two testable halves live here as pure functions because `app/fleet-ui` runs vitest with
 * `environment: 'node'` (jsdom cannot be installed on this workstation — npm E401 against the
 * internal registry), so a hook cannot be tested but its rules can. The hook below holds no rules
 * of its own.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Separator in the URL value. Safe because a namespace is a DNS-1123 label: lowercase
 *  alphanumerics and `-` only, so it can never contain a comma that would split one name in two. */
const SEP = ',';

/** One shared instance for the common case, so an unfiltered render is referentially stable and a
 *  `useMemo` downstream of it does not recompute on every keystroke elsewhere on the page. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * The selection encoded in one URL parameter, narrowed to the namespaces that actually exist.
 *
 * An empty set means "all namespaces" throughout this feature (see `namespace-filter.ts`), so a
 * missing or empty parameter and a cleared filter are the same state — there is no third state to
 * keep in agreement.
 *
 * Values absent from `options` are dropped: a link carrying a namespace that has since been
 * deleted, or a typo in a hand-edited URL, must not filter every row away and leave the operator
 * looking at an empty table with nothing on screen explaining it.
 *
 * **`options` empty is the trap.** On the first render the cluster payload has not arrived, so
 * there are no options yet — narrowing against that would discard a perfectly good selection from
 * a shared link, and because the control writes the URL back on the next change, it would discard
 * it permanently. So an empty option list means "not known yet", and the raw selection passes
 * through untouched. Narrowing resumes as soon as there is something to narrow against.
 */
export function parseNamespaceParam(raw: string | null, options: readonly string[]): ReadonlySet<string> {
  if (!raw) return EMPTY;
  const named = raw
    .split(SEP)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (named.length === 0) return EMPTY;
  if (options.length === 0) return new Set(named);
  const allowed = new Set(options);
  return new Set(named.filter(ns => allowed.has(ns)));
}

/**
 * The URL value for a selection, or `null` to remove the parameter entirely.
 *
 * `null` rather than an empty string, because "all namespaces" is the default and a default does
 * not belong in a URL — `?ns=` in a shared link reads as a filter that was set and then broke.
 *
 * Sorted, so two operators who tick the same two namespaces in opposite orders produce the *same*
 * URL. That matters beyond tidiness: an unsorted value makes one logical view into N! distinct
 * strings, which defeats any cache keyed on the query and makes two identical views look different
 * in a bug report.
 */
export function serializeNamespaceParam(selected: ReadonlySet<string>): string | null {
  if (selected.size === 0) return null;
  return [...selected].sort((a, b) => a.localeCompare(b)).join(SEP);
}

/**
 * Read and write the namespace selection on a caller-chosen URL key.
 *
 * `replace: true`, following `useUrlSection`: ticking six namespaces must not cost six Back
 * presses to leave the page. Filtering is not a navigation an operator wants to unwind one step at
 * a time.
 *
 * `?res=` is deliberately **kept**, unlike on a section change. A section change re-scopes the page
 * so a resource selected in the old section is genuinely no longer on screen; a namespace filter
 * does not unmount anything, and the drawer resolves its subject against the unfiltered rows.
 * Dropping the drawer here would close it as a side effect of ticking a checkbox.
 *
 * @param param the URL key, e.g. `ns`. Give each independent table its own key for the same reason
 *   nested section strips cannot share `?section=`: whichever wrote last would reset the other.
 * @param options every namespace present in the rows on screen, used only to drop stale values.
 */
export function useNamespaceSelection(
  param: string,
  options: readonly string[]
): [ReadonlySet<string>, (next: ReadonlySet<string>) => void] {
  const [params, setParams] = useSearchParams();
  const selected = parseNamespaceParam(params.get(param), options);

  const setSelected = useCallback(
    (next: ReadonlySet<string>) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          const value = serializeNamespaceParam(next);
          if (value === null) p.delete(param);
          else p.set(param, value);
          return p;
        },
        { replace: true }
      );
    },
    [setParams, param]
  );

  return [selected, setSelected];
}
