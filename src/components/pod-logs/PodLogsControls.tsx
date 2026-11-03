/**
 * The log controls. One row, one implementation, both log surfaces.
 *
 * Every control is a *view* control: it changes how much of the log is read and which of it is
 * shown. None of them sends anything to a cluster — there is no follow/stop-container/kill here and
 * there must never be, because this console is read-only by construction.
 *
 * The props are values-and-setters rather than a state object so that the tab can back them with the
 * URL (a log is linkable) and the drawer can back them with `useState` (opening a drawer must not
 * rewrite the page's URL) without either of them reimplementing the row.
 */
import type { LogContainer } from '../../api';
import { Btn } from '../ui';
import { LOG_DIRECTIONS, type LogDirection } from '../../pages/cluster-tabs/log-pods';
import { LEVEL_FLOORS, type LevelFloor } from './level';

const TAIL_CHOICES = [100, 200, 500, 1000, 2000];

/** A labelled select, sized and spaced identically everywhere this row appears. */
function Pick({
  label,
  value,
  onChange,
  title,
  children
}: {
  label: string;
  value: string | number;
  onChange: (next: string) => void;
  title?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-muted" title={title}>
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="mono h-7 rounded-[6px] border border-line bg-raised px-1.5 text-[13px] text-text"
        aria-label={label}
      >
        {children}
      </select>
    </label>
  );
}

export interface PodLogsControlsProps {
  tailLines: number;
  onTailLines: (n: number) => void;
  dir: LogDirection;
  onDir: (d: LogDirection) => void;
  level: LevelFloor;
  onLevel: (l: LevelFloor) => void;
  autoMs: number;
  onAutoMs: (ms: number) => void;
  search: string;
  onSearch: (s: string) => void;
  /** The container being read, for the previous-instance toggle's own availability. */
  containerInfo: LogContainer | null;
  previous: boolean;
  onPrevious: (p: boolean) => void;
  loading: boolean;
  onReload: () => void;
  /** Rendered last on the row. The drawer puts "Open in Live Pod Logs" here. */
  trailing?: React.ReactNode;
}

export function PodLogsControls({
  tailLines,
  onTailLines,
  dir,
  onDir,
  level,
  onLevel,
  autoMs,
  onAutoMs,
  search,
  onSearch,
  containerInfo,
  previous,
  onPrevious,
  loading,
  onReload,
  trailing
}: PodLogsControlsProps): JSX.Element {
  return (
    <div className="panel-head flex shrink-0 flex-wrap items-center gap-3 py-2">
      <Pick label="Tail" value={tailLines} onChange={v => onTailLines(Number(v))}>
        {TAIL_CHOICES.map(n => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Pick>

      <Pick
        label="Order"
        value={dir}
        onChange={v => onDir(v as LogDirection)}
        title="Newest first opens on the most recent line and walks backwards as you scroll down. Oldest first is the order the container wrote — the only one in which a multi-line stack trace reads correctly."
      >
        {LOG_DIRECTIONS.map(d => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </Pick>

      <Pick
        label="Level"
        value={level}
        onChange={v => onLevel(v as LevelFloor)}
        title="The server assigns a level from the line's own text. Most real output carries none at all — a severity floor cannot see those lines, and the footer says how many it set aside."
      >
        {LEVEL_FLOORS.map(f => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </Pick>

      <Pick label="Auto-refresh" value={autoMs} onChange={v => onAutoMs(Number(v))}>
        <option value={0}>Off</option>
        <option value={5000}>5s</option>
        <option value={10000}>10s</option>
      </Pick>

      {/* Only where it can do something. A container that has never restarted has no previous
          instance, and a checkbox that always answers "no previous instance" is a dead control. */}
      {containerInfo?.hasPrevious ? (
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={previous} onChange={e => onPrevious(e.target.checked)} />
          <span className={previous ? 'text-warn' : 'text-muted'}>
            Previous instance{previous ? ' (before the last restart)' : ''}
          </span>
        </label>
      ) : (
        <span className="text-[13px] text-muted" title="This container has not restarted">
          no previous instance
        </span>
      )}

      <input
        type="search"
        value={search}
        onChange={e => onSearch(e.target.value)}
        placeholder="search logs"
        className="mono h-7 min-w-[140px] flex-1 rounded-[6px] border border-line bg-raised px-2 text-[13px]"
        aria-label="Search log lines"
      />

      <Btn onClick={onReload} disabled={loading}>
        {loading ? 'Reading…' : 'Reload'}
      </Btn>
      {trailing}
    </div>
  );
}
