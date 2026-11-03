/**
 * The controls above a table: which columns it shows, in what order, and how tall its rows are.
 *
 * Quiet on purpose, and quiet in a specific way: the row is invisible until the pointer is over the
 * table or something inside it has keyboard focus (see `.table-tools` in theme.css). A Helm release
 * page stacks six tables one under another, and a permanently visible control row above each one put
 * twelve pale buttons down a page whose actual content is the resources — the toolbar became the
 * texture of the page rather than a control on it. It stays visible whenever the table is *not* in its
 * default state, because a column the operator hid earlier has to have a visible way back.
 *
 * Reordering lives in this menu as ↑/↓ buttons *as well as* on the header itself as drag-and-drop.
 * The drag is the fast path; the buttons are the one that works from a keyboard, and an operations
 * console that needs a mouse is a broken one.
 */
import type { RowMode } from './prefs';
import { Popover } from './Popover';

export interface ToolColumn {
  key: string;
  label: string;
  locked: boolean;
  hidden: boolean;
}

export function TableTools({
  columns,
  rows,
  dirty,
  onToggle,
  onMove,
  onRows,
  onReset
}: {
  columns: ToolColumn[];
  rows: RowMode;
  /** Whether anything differs from the declared default — which is when Reset is worth offering. */
  dirty: boolean;
  onToggle: (key: string) => void;
  onMove: (key: string, delta: -1 | 1) => void;
  onRows: (mode: RowMode) => void;
  onReset: () => void;
}) {
  const hideable = columns.filter(c => !c.locked);
  const hiddenCount = columns.filter(c => c.hidden).length;
  const movable = columns.filter(c => !c.locked);

  return (
    <div className="table-tools" data-dirty={dirty || undefined}>
      <button
        type="button"
        className="table-tool"
        aria-pressed={rows === 'wrap'}
        title={
          rows === 'wrap'
            ? 'Back to one line per row. Long names truncate with an ellipsis and show in full on hover.'
            : 'Let long names wrap onto a second line. Rows grow taller and every other column stays vertically centred.'
        }
        onClick={() => onRows(rows === 'wrap' ? 'compact' : 'wrap')}
      >
        {rows === 'wrap' ? 'Single line' : 'Wrap names'}
      </button>

      {hideable.length > 0 && (
        <Popover
          label={hiddenCount ? `Columns · ${columns.length - hiddenCount}/${columns.length}` : 'Columns'}
          title="Show, hide and reorder this table's columns. Remembered for next time."
        >
          {close => (
            <>
              <ul className="popover-list">
                {columns.map(c => (
                  <li key={c.key}>
                    <label
                      title={c.locked ? 'This column identifies the row or acts on it, so it always stays.' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={!c.hidden}
                        disabled={c.locked}
                        onChange={() => onToggle(c.key)}
                      />
                      <span className={c.locked ? 'text-muted' : ''}>{c.label}</span>
                    </label>
                    {!c.locked && (
                      <span className="popover-move">
                        <button
                          type="button"
                          title={`Move ${c.label} left`}
                          // Disabled at the ends of the *movable* run, not of the whole array: the
                          // first movable column cannot swap with a locked identity column.
                          disabled={movable[0]?.key === c.key}
                          onClick={() => onMove(c.key, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          title={`Move ${c.label} right`}
                          disabled={movable[movable.length - 1]?.key === c.key}
                          onClick={() => onMove(c.key, 1)}
                        >
                          ↓
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="popover-foot">
                {/* Closing is the confirmation: a menu still showing its own controls after Reset
                    reads as if the press did nothing. */}
                <button
                  type="button"
                  disabled={!dirty}
                  onClick={() => {
                    onReset();
                    close();
                  }}
                >
                  Reset to default
                </button>
              </div>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
