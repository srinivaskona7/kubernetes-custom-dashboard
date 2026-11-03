/**
 * The namespace filter, as a toolbar control.
 *
 * It holds no rules: which namespaces exist, what a selection means and what the toolbar should say
 * about it all live in `namespace-filter.ts`, which is tested. This file renders those answers, which
 * is why the only state it owns is the search needle — everything else is the caller's, so the same
 * control can sit above Pods, Deployments, Services or Secrets and the page keeps one source of truth
 * for what is filtered (requirement 15).
 *
 * Inspection-only, like the rest of `filters.tsx`: the one thing it can do is call `onChange`. There
 * is deliberately no affordance here that reaches a cluster.
 */
import { useState } from 'react';
import { SearchBox } from './filters';
import { Popover } from './table/Popover';
import { namespaceLabel, namespaceTitle, searchNamespaces, toggleNamespace } from './namespace-filter';

/**
 * How many namespaces it takes before a search box earns its row.
 *
 * Under a dozen, the whole list is visible in the panel without scrolling on any window and looking is
 * faster than typing — a search box above four checkboxes is one more thing to read on a console whose
 * density budget is spent on data. From a dozen up the list starts to scroll on a short window (the
 * panel is capped at `min(60vh, 460px)`, which on a 700px-tall window leaves room for about fifteen
 * 23px rows), and search becomes the only way to reach a name without dragging past it.
 */
const SEARCH_AT = 12;

export function NamespaceFilter({
  options,
  selected,
  onChange,
  label = 'Namespace'
}: {
  /** Every namespace present in the rows on screen, already sorted. */
  options: readonly string[];
  /** The current selection. An EMPTY SET MEANS "all namespaces" — see namespace-filter.ts. */
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /**
   * What the control calls the thing it filters.
   *
   * Overridable because on one screen a namespace selection does not mean what it means everywhere
   * else: Traffic Errors passes 'Proxy namespace', where `?namespace=` scopes *which proxies are
   * tailed* rather than which rows come back. Labelling that "Namespace" would invite an operator to
   * read it as a row filter and trust a result that was never filtered.
   */
  label?: string;
}): JSX.Element {
  /**
   * The needle survives the panel closing, on purpose. It is visible in the box the moment the panel
   * reopens, so it is not hidden state — and clearing it would make the second visit to a
   * sixty-namespace cluster start from scratch, which is exactly the trip the search exists to save.
   */
  const [search, setSearch] = useState('');

  const active = selected.size > 0;

  /**
   * The label sits *inside* the button rather than beside it as `FilterSelect`'s does, with the same
   * muted 13px type so the two still read as one family. A `<label>` can only be associated with a
   * form control, never with a button, so a "Namespace" span outside would be decoration a screen
   * reader never connects to the thing it names; inside, the button's accessible name is
   * "Namespace <selection>" with no extra wiring — and that is also why the `label` prop exists rather
   * than the caller rendering its own word beside the control.
   */
  const trigger = (
    <>
      <span className="filter-tool-label">{label}</span>
      <span className="filter-tool-value">{namespaceLabel(selected)}</span>
      <span aria-hidden="true" className="filter-tool-caret">
        ▾
      </span>
    </>
  );

  /**
   * Nothing to filter by, so the control says so instead of opening an empty menu — an operator who
   * opens a filter and finds no options cannot tell a cluster-scoped table from a failed read.
   *
   * The label reads "All namespaces" rather than whatever is in `selected`: with no options a
   * selection cannot be honoured, and claiming one would be the console lying about what it is showing.
   * Callers keep it from happening with `pruneNamespaces`.
   */
  if (options.length === 0) {
    return (
      <button type="button" className="filter-tool" disabled title={namespaceTitle(new Set(), 0)}>
        <span className="filter-tool-label">{label}</span>
        <span className="filter-tool-value">{namespaceLabel(new Set())}</span>
      </button>
    );
  }

  const shown = searchNamespaces(options, search);
  const needle = search.trim();

  return (
    <Popover
      label={trigger}
      title={namespaceTitle(selected, options.length)}
      align="left"
      /*
       * The active state is carried by the trigger's own colour, not by a count `Pill` as `FilterBar`
       * uses for its reset. Two reasons: the label already names the selection — one namespace in full,
       * more as a count — so a pill would print the same number twice; and a `Pill`'s leading `Dot` is
       * this console's status vocabulary, so an accent pill on a filter would read as a health verdict
       * on the rows. Requirement 13 needs the filter legible *without* hovering, and `.filter-tool-on`
       * is what makes it so.
       */
      triggerClass={active ? 'filter-tool filter-tool-on' : 'filter-tool'}
    >
      {close => (
        <>
          {options.length >= SEARCH_AT && (
            <div className="popover-search">
              <SearchBox value={search} onChange={setSearch} placeholder="Find a namespace" />
            </div>
          )}
          <ul className="popover-list">
            {shown.map(ns => (
              <li key={ns}>
                <label>
                  {/*
                    A real checkbox with a real label, so the row is operable from a keyboard and
                    announces its own checked state. Toggling deliberately leaves the panel open:
                    selecting three namespaces (requirement 4) would otherwise take three trips
                    through the menu.
                  */}
                  <input
                    type="checkbox"
                    checked={selected.has(ns)}
                    onChange={() => onChange(toggleNamespace(selected, ns))}
                  />
                  <span>{ns}</span>
                </label>
              </li>
            ))}
          </ul>
          {shown.length === 0 && (
            /* Naming the needle back: an empty panel looks like a read that returned nothing. */
            <p className="py-2 text-[13px] text-muted">
              No namespace matches <span className="text-text">{needle}</span>.
            </p>
          )}
          <div className="popover-foot">
            <button
              type="button"
              /*
               * Disabled *and* ticked when it is already the state. Disabled alone would be a button
               * that appears to do nothing; the tick says which of the two states the panel is in,
               * which is the half requirement 14 needs — "All namespaces" and "clear the filter" are
               * one state in `namespace-filter.ts`, so one control has to show both.
               */
              disabled={!active}
              title={
                active
                  ? 'Clear the filter and show every namespace again. Nothing is sent to the cluster.'
                  : 'Every namespace is already showing.'
              }
              onClick={() => {
                onChange(new Set());
                close();
              }}
            >
              {active ? 'All namespaces' : '✓ All namespaces'}
            </button>
          </div>
        </>
      )}
    </Popover>
  );
}
