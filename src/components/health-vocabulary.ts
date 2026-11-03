import type { GroupSummary, HealthSignal, PerClusterGroups } from '../api';
import type { Tone } from './ui';

/**
 * The health vocabulary — one owner for the colour, the word and the order.
 *
 * This exists because there were three. `OverviewTab` had `TONE_OF`/`WORD_OF`/`RANK`; `layout.tsx`
 * hand-rolled its own tone and word inline for the rail dots; and the two orderings **disagreed**,
 * so a cluster with one unread topic and one warning got "Unread" in the rail while the Overview's
 * attention list led with the warning. Worse, the rail's inline mapping had no `partial` case, so
 * it said "Warning" where the page said "Partial" about the same group.
 *
 * `state` and `health` are two separate verdicts on every group (see `GroupSummary`); everything
 * here is about `health` only. Completeness has its own vocabulary and its own place on the tile.
 */

export type Health = GroupSummary['health'];

/** Health drives the colour, because health is what the operator is scanning for. */
export const TONE_OF: Record<Health, Tone> = {
  attention: 'bad',
  warn: 'warn',
  unknown: 'unknown',
  partial: 'warn',
  clear: 'ok'
};

/**
 * The word beside the dot. `Pill` renders both, so the grid survives greyscale and colour
 * blindness in a way seventeen bare dots would not.
 *
 * "Unread" rather than "Failed" for `unknown`: the topic did not fail, the *attempt to look at
 * it* did, and those need different words when the next step differs (check the workload vs
 * check the role binding).
 */
export const WORD_OF: Record<Health, string> = {
  attention: 'Attention',
  warn: 'Warning',
  unknown: 'Unread',
  partial: 'Partial',
  clear: 'Clear'
};

/**
 * Worst first — and `unknown` sits **above** `warn`, not below it.
 *
 * A topic nobody could read may be hiding an attention-level problem, so it outranks a warning
 * that is fully known and merely minor. That is the same principle `healthOf` states on the server:
 * a refused read has no clean bill of health to give. `partial` ranks below `warn` because its
 * findings *are* known — some other read in the group is what came up short.
 */
export const RANK: Record<Health, number> = { attention: 0, unknown: 1, warn: 2, partial: 3, clear: 4 };

/** Total order over `RANK`, tolerant of a health value a future server adds. */
export const rankOf = (h: Health): number => RANK[h] ?? RANK.unknown;

/** `3 containers crashlooping`, `40% of namespaces have no ResourceQuota`, `single availability zone`. */
export function phrase(s: HealthSignal): string {
  return s.count === null ? s.label : `${s.count}${s.unit ?? ''} ${s.label}`;
}

/** The worst `[groupKey, verdict]` across a cluster's topics, or null when there are none. */
export function worstOf(
  groups: PerClusterGroups[string] | undefined
): [string, NonNullable<PerClusterGroups[string][keyof PerClusterGroups[string]]>] | null {
  let worstEntry: [string, NonNullable<PerClusterGroups[string][keyof PerClusterGroups[string]]>] | null = null;
  let worst = Infinity;
  for (const [key, g] of Object.entries(groups || {})) {
    if (!g) continue;
    const r = rankOf(g.health);
    if (r < worst) {
      worst = r;
      worstEntry = [key, g];
    }
  }
  return worstEntry;
}
