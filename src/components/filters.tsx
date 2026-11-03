/**
 * The filter controls every dense table on this console shares.
 *
 * Extracted from the first screens that wrote them once a second family of tables (Top
 * Utilization) needed the same three: a labelled select whose options are always the real values
 * present in the data, a debounced search box, and the bar that holds them with a reset that only
 * appears when it would do something.
 *
 * All three are inspection-only. They change what is shown; none of them sends anything to a
 * cluster.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pill } from './ui';

/** A labelled `<select>`. Options are always the real values present in the data, never a guess. */
export function FilterSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-muted">
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-8 rounded-[6px] border border-line bg-raised px-2 text-[13px] text-text"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A checkbox filter.
 *
 * A checkbox rather than a two-option select, because it is a filter that is either on or off and a
 * select would need a label for the off state — "Show system namespaces / Hide system namespaces" is
 * two readings of one control. Discrete, so it writes immediately; only text entry is debounced.
 */
export function FilterToggle({
  label,
  checked,
  onChange,
  title
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Why an operator would want this, and what it hides. */
  title?: string;
}): JSX.Element {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-muted" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}

/**
 * The search box, debounced.
 *
 * Local state drives the input and the URL is written 200ms after typing stops. Writing on every
 * keystroke would push a history entry per character and re-filter the list mid-word; not
 * debouncing the local value would make the input lag behind the keyboard.
 */
export function SearchBox({
  value,
  onChange,
  placeholder
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}): JSX.Element {
  const [text, setText] = useState(value);
  const committed = useRef(value);

  // An external change (a finding's drilldown, a Reset click) has to win over the local draft.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (text === committed.current) return;
    const t = setTimeout(() => {
      committed.current = text;
      onChange(text);
    }, 200);
    return () => clearTimeout(t);
  }, [text, onChange]);

  return (
    <input
      type="search"
      value={text}
      onChange={e => setText(e.target.value)}
      placeholder={placeholder}
      className="h-8 min-w-[220px] flex-1 rounded-[6px] border border-line bg-raised px-2.5 text-[13px] text-text placeholder:text-muted"
    />
  );
}

/** The bar itself: search, then the selects, then the reset that only appears when it would do something. */
export function FilterBar({
  children,
  activeCount,
  onReset,
  resultLine
}: {
  children: ReactNode;
  activeCount: number;
  onReset: () => void;
  resultLine: ReactNode;
}): JSX.Element {
  return (
    <div className="filter-bar mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3">
      {children}
      <span className="ml-auto flex items-center gap-3 text-[13px] text-muted">
        {resultLine}
        {activeCount > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-raised px-2.5 text-[13px] text-text hover:border-line-strong"
          >
            <Pill tone="accent">{activeCount}</Pill>
            Clear filters
          </button>
        )}
      </span>
    </div>
  );
}
