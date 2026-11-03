/**
 * The shared finding descriptor.
 *
 * A "finding" is any statement this console makes that an operator should be able to act on: a
 * count on a summary card, a red pill in a list, a named reason on a policy. The rule the master
 * spec states, and the one thing this module exists to enforce: **every finding must resolve to
 * the rows it is about.** A card that says "3 dry-run policies" and does nothing when clicked has
 * told the operator there is a problem and then withheld the problem.
 *
 * ## Why this is its own module, ahead of the full shared implementation
 *
 * The shared finding surface (a `FindingLink` used by every tab, a fleet-wide findings index) is
 * still outstanding. The temptation while building the first screen that needs findings is to
 * write an OPA-shaped drilldown and move on — and that produces exactly the throwaway that cannot
 * migrate: an `onClick` closure that sets local component state has no id, no severity and no
 * serialisable destination, so the later shared version cannot adopt it without rewriting every
 * call site.
 *
 * So the descriptor is defined here, in the shape the shared version needs, and OPA is its first
 * consumer. What is deliberately NOT here yet: the cross-tab registry, and the fleet-level
 * aggregation. Those are additive — they consume `Finding[]`, and nothing below changes when they
 * arrive.
 *
 * ## Why the destination is URL state and not a callback
 *
 * A finding's target has to survive being copied into a ticket. `{ tab, params }` serialises; a
 * closure does not. It is also the only form that works across tabs: a finding raised on the
 * Overview whose rows live on Violations must be able to name that place without importing it.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * How much this finding should worry the reader.
 *
 * `info` is not an absence of severity — it is a finding worth a click that is not a problem
 * ("19 policies enforce deny"). Rendering it in the same red as `critical` is how a dashboard
 * teaches operators to ignore it.
 */
export type FindingSeverity = 'critical' | 'warning' | 'info';

/** A pointer to the object a finding is about, in the console's existing `?res=` vocabulary. */
export interface FindingSubject {
  kind: string;
  namespace: string | null;
  name: string;
}

/**
 * Where a finding's rows live, as URL state.
 *
 * `params` is applied on top of the current query rather than replacing it, so a destination
 * inside the current tab does not have to restate the tab, the section or the cluster. A `null`
 * value clears that key — which is how "show all namespaces" is expressed.
 */
export interface FindingDestination {
  /** The cluster tab id, when the rows are on a different tab. Omitted for same-tab. */
  tab?: string;
  /** The `?section=` value, when the rows are in a different sub-section. */
  section?: string;
  /** Any further query keys the destination screen reads as its filter state. */
  params?: Record<string, string | null>;
}

/**
 * How fresh the evidence behind a finding is.
 *
 * Separate from the finding itself because the two decay independently: "0 violations" from an
 * audit that last ran four days ago is not the same statement as "0 violations" from one that ran
 * forty seconds ago, and only the second one is worth trusting.
 */
export interface FindingFreshness {
  state: 'fresh' | 'stale' | 'never' | 'unknown';
  at: string | null;
  /** One clause explaining the state, for the tooltip: "audit last ran 4 days ago". */
  detail?: string;
}

export interface Finding {
  /**
   * Stable across refetches and across sessions. Built from what the finding is ABOUT, never
   * from its position in a list, so a bookmark to a finding still points at the same one.
   */
  id: string;
  severity: FindingSeverity;
  /** One sentence, in the operator's language, stating what was found. */
  summary: string;
  /** How many objects this finding covers. `null` when the count itself could not be read. */
  affectedCount: number | null;
  /** The objects, when they are known and few enough to name. */
  subjects?: FindingSubject[];
  destination: FindingDestination;
  freshness?: FindingFreshness;
  /** Which read produced this — `gatekeeper-audit`, `admission-metric`, `constraint-status`. */
  source: string;
}

/**
 * Apply a `FindingDestination` to the current URL.
 *
 * `replace: true` for the same reason sub-tab clicks use it: following a finding is refining the
 * view, not a navigation step the operator wants to unwind one key at a time.
 *
 * `res` is cleared on every jump. The destination re-scopes the list, so a resource selected
 * before the jump is very likely no longer in it, and a drawer showing an object the list behind
 * it does not contain is the confusing state this avoids.
 */
export function useFindingNavigation(): (destination: FindingDestination) => void {
  const [, setParams] = useSearchParams();
  return useCallback(
    (destination: FindingDestination) => {
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (destination.tab) next.set('tab', destination.tab);
          if (destination.section) next.set('section', destination.section);
          for (const [key, value] of Object.entries(destination.params ?? {})) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          next.delete('res');
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
}

/** Tone for a severity. One mapping, so two screens cannot disagree about what warning looks like. */
// `info` is grey, not the brand violet: violet is never a status, and an info finding on a
// high-risk strip drawn in the accent colour read as one more thing to fix.
export const SEVERITY_TONE: Record<FindingSeverity, 'bad' | 'warn' | 'unknown'> = {
  critical: 'bad',
  warning: 'warn',
  info: 'unknown'
};
