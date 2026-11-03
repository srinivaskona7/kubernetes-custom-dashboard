/**
 * The first thing on every Ingress & Traces sub-tab: what is wrong, worst first, each row one press
 * from the thing it names. Three rows by default so the table under it keeps its height.
 *
 * `problems === null` is a source that was not read, and says Unavailable; `[]` is a read that found
 * nothing. The two never share a sentence.
 */
import { useState } from 'react';
import { Dot, Pill, type Tone } from '../../components/ui';
import { Unavailable } from '../../components/unavailable';
import type { Problem, ProblemSeverity } from './problems';

// Info is a neutral grey, never the violet accent: accent is the brand, not a status.
const TONE: Record<ProblemSeverity, Tone> = { bad: 'bad', warn: 'warn', info: 'unknown' };
const WORD: Record<ProblemSeverity, string> = { bad: 'critical', warn: 'warning', info: 'info' };
const COLLAPSED = 3;

/** The rows the strip shows: the first `n` collapsed, every one expanded. */
export function visibleProblems<T>(ps: readonly Problem<T>[], expanded: boolean, n = COLLAPSED): Problem<T>[] {
  return expanded ? [...ps] : ps.slice(0, n);
}

export function ProblemStrip<T>({
  problems,
  unavailableWhy,
  onOpen,
  title = 'Problems',
  collapsed = COLLAPSED,
  emptyText = 'No problems in the sample'
}: {
  problems: Problem<T>[] | null;
  unavailableWhy: string;
  onOpen: (p: Problem<T>) => void;
  title?: string;
  /** Rows shown before "Show N more"; a screen whose table needs the height passes fewer. */
  collapsed?: number;
  /** The read-and-clean line; a screen that set rows aside names them here instead. */
  emptyText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = problems ? visibleProblems(problems, expanded, collapsed) : [];
  return (
    <section aria-label={title} className="mb-3 shrink-0 rounded-[8px] border border-line bg-surface">
      <header className="panel-head flex items-baseline gap-2 py-1.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{title}</h2>
        {problems && <span className="mono text-[12px] text-muted">{problems.length}</span>}
      </header>
      {!problems ? (
        <p className="panel-x py-2 text-[13px]">
          <Unavailable what={title} why={unavailableWhy} />
        </p>
      ) : problems.length === 0 ? (
        <p className="panel-x flex items-baseline gap-2 py-2 text-[13px] text-muted">
          <Dot tone="ok" />
          {emptyText}
        </p>
      ) : (
        // Expanded, the list scrolls inside its own box: the strip sits in the screen's fixed header,
        // so growing it would take the rows from the table below.
        <ul className={`divide-y divide-line ${expanded ? 'max-h-[196px] overflow-y-auto overscroll-contain' : ''}`}>
          {shown.map(p => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => onOpen(p)}
                title={[p.title, p.detail].filter(Boolean).join(' — ')}
                className="panel-x flex w-full items-baseline gap-3 py-1.5 text-left transition-colors hover:bg-raised/40"
              >
                <span className="w-[72px] shrink-0">
                  <Pill tone={TONE[p.severity]} size="sm">
                    {WORD[p.severity]}
                  </Pill>
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12px] text-text">{p.title}</span>
                {p.detail && <span className="max-w-[40%] truncate text-[12px] text-muted">{p.detail}</span>}
                {p.count ? (
                  <span className="mono w-[56px] shrink-0 text-right text-[12px] tabular-nums text-muted">{p.count.toLocaleString('en-US')}</span>
                ) : (
                  <span className="w-[56px] shrink-0" />
                )}
              </button>
            </li>
          ))}
          {problems.length > collapsed && (
            <li>
              <button type="button" onClick={() => setExpanded(v => !v)} className="panel-x w-full py-1 text-left text-[12px] text-muted hover:text-text">
                {expanded ? 'Show fewer' : `Show ${problems.length - collapsed} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
