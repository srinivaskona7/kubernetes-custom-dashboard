/**
 * Sub-navigation inside one cluster tab.
 *
 * Every multi-topic tab used to be one long scroll that fetched all of its sources on mount —
 * Security paid for the policy sweep to show a NetworkPolicy percentage, Nodes paid for the
 * capacity walk to show a node list. Sub-tabs fix both problems at once: the page gets a
 * hierarchy an operator can navigate, and **only the mounted section fetches**, which is the
 * cheapest performance lever this console has. Sections are unmounted, not hidden.
 *
 * ## Why the id lives in the URL
 *
 * `?section=` rather than `useState`, for the same reason `?tab=` does: a sub-section is a
 * place, and a place has to survive a refresh, a copied link and the back button. It is also
 * what lets the resource drawer work — a `?res=Certificate/...` deep link can only resolve once
 * the section owning Certificates is mounted to lend its payload, so `ClusterDetail` must be
 * able to put the page there (see `ResourceDefinition.home`).
 *
 * One `?section=` key is shared by every tab. That is deliberate and safe: `useSection` falls
 * back to its own default whenever the current value is not one of its ids, so arriving at
 * Security carrying `?section=mesh` from Networking lands on Security's first section rather
 * than on a blank page.
 */
import { useCallback, useId } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface SubTab<Id extends string> {
  id: Id;
  label: string;
  description?: string;
}

/**
 * Read and write the active section for one tab's own list.
 *
 * `replace: true` — moving between sections of a page is not a navigation an operator wants to
 * unwind one step at a time; Back should leave the tab, not walk its sections.
 */
export function useSection<Id extends string>(
  sections: readonly SubTab<Id>[],
  fallback: Id
): [Id, (next: Id) => void] {
  return useUrlSection('section', sections, fallback);
}

/**
 * The same hook on a caller-chosen URL key, for a second level of nesting.
 *
 * A tab → section → nested view is three levels deep, and the two inner ones cannot share
 * `?section=`: whichever wrote last would knock the other back to its fallback on every click. So
 * the nested strip gets its own key (`?view=`, say), which also keeps the two independent —
 * arriving on `?section=a&view=b` restores both, and `?section=c&view=b` is harmless because the
 * nested strip is not mounted to read it.
 *
 * `keep` is the escape hatch for a nested strip whose sections are views of one already-selected
 * thing: those must not drop `?res=`, because the drawer IS the thing being viewed.
 */
export function useUrlSection<Id extends string>(
  param: string,
  sections: readonly SubTab<Id>[],
  fallback: Id,
  { keepResource = false }: { keepResource?: boolean } = {}
): [Id, (next: Id) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const active = (sections.find(s => s.id === raw)?.id ?? fallback) as Id;

  const setSection = useCallback(
    (next: Id) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          p.set(param, next);
          // A section change re-scopes the page, so a resource selected in the old section is
          // no longer on screen and its drawer would render "not in view". Dropping it is the
          // honest move and keeps the URL describing what is actually shown.
          if (!keepResource) p.delete('res');
          return p;
        },
        { replace: true }
      );
    },
    [setParams, param, keepResource]
  );

  return [active, setSection];
}

/**
 * The strip itself.
 *
 * Real `<button role="tab">` elements inside a `role="tablist"`, so the strip is reachable and
 * announced; the active one is marked with `aria-selected` as well as colour, because status
 * and position in this console are never colour alone.
 */
export function SubTabs<Id extends string>({
  sections,
  active,
  onSelect,
  counts,
  className = ''
}: {
  sections: readonly SubTab<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Optional per-section count. Omit an id entirely when its number is not yet known — a
   *  section that has not fetched must not render a `0` that reads as "none found". */
  counts?: Partial<Record<Id, number | null>>;
  className?: string;
}): JSX.Element {
  const tooltipBase = useId();

  return (
    <div role="tablist" className={`mb-4 flex flex-wrap gap-2 border-b border-line pb-3 ${className}`}>
      {sections.map(s => {
        const selected = s.id === active;
        const count = counts?.[s.id];
        const tooltipId = s.description ? `${tooltipBase}-${s.id}` : undefined;
        return (
          <span key={s.id} className="subtab-item group/tab relative">
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              aria-describedby={tooltipId}
              onClick={() => onSelect(s.id)}
              className={`min-h-11 rounded-[6px] px-3 py-1.5 text-[14px] font-medium transition-colors ${
                selected ? 'bg-accent text-white' : 'text-muted hover:text-text'
              }`}
            >
              {s.label}
              {typeof count === 'number' && (
                <span className={`mono ml-1.5 text-[12px] ${selected ? 'text-white/70' : 'text-muted'}`}>
                  {count}
                </span>
              )}
            </button>
            {s.description && (
              <span
                id={tooltipId}
                role="tooltip"
                className="subtab-tip pointer-events-none invisible absolute left-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-raised/95 px-3 py-2 text-left text-[12px] font-normal normal-case leading-snug text-text opacity-0 shadow-lg backdrop-blur transition-opacity group-hover/tab:visible group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:visible group-has-[:focus-visible]/tab:opacity-100"
              >
                {s.description}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
