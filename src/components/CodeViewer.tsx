/**
 * The console's one read-only code pane.
 *
 * Extracted from the two hand-rolled copies that had grown apart — `HelmReleasePage`'s
 * `CodeBlock`/`colouriseYaml` and `PolicyDrawer`'s bare `<pre>` — because the Values, Manifest and
 * policy-YAML screens must agree on what a code pane is: the same label chip, the same search, the
 * same copy button, the same monospace metrics. Two implementations is how one of them silently
 * loses the label that says which copy of an object you are reading.
 *
 * ## The label is not decoration
 *
 * `LIVE CLUSTER RESOURCE`, `HELM RENDERED MANIFEST`, `HELM VALUES`, `LIVE CONSTRAINTTEMPLATE` —
 * an operator debugging the rendered manifest when they meant the live object loses an afternoon,
 * so the label is a required prop and it is printed above every pane.
 *
 * ## Read-only, structurally
 *
 * The content is a `<pre>`, never a textarea or an editor. Copy is the only outbound control and
 * it writes to the clipboard, not to the cluster.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { valueDiffMarks, type DiffMark, type ValueDelta } from './code-compare';

/** One JSON line split into `"key":` and its value, each given its own colour. */
function jsonLine(line: string): ReactNode {
  const match = /^(\s*)"([^"]+)":\s?(.*)$/.exec(line);
  if (!match) return <span className="text-muted">{line}</span>;
  const [, indent, key, rest] = match;
  const tail = rest ?? '';
  return (
    <>
      {indent}
      <span className="text-accent">{key}</span>
      <span className="text-muted">: </span>
      <span className={tail.startsWith('"') ? 'text-ok' : /^-?\d/.test(tail) ? 'text-warn' : 'text-text'}>{tail}</span>
    </>
  );
}

/**
 * One YAML line, coloured by role. Separate from `jsonLine` because YAML has comments and list
 * markers and its keys are unquoted. `[redacted]` is coloured as a warning rather than as a value,
 * because that is what it is: a value this console deliberately did not carry.
 */
function yamlLine(line: string): ReactNode {
  if (/^\s*#/.test(line)) return <span className="text-muted/70">{line}</span>;
  const match = /^(\s*-?\s*)([^:\s][^:]*):(.*)$/.exec(line);
  if (!match) return <span className="text-text">{line}</span>;
  const [, indent, key, rest] = match;
  const tail = rest ?? '';
  return (
    <>
      {indent}
      <span className="text-accent">{key}</span>
      <span className="text-muted">:</span>
      <span className={tail.trim() === '[redacted]' ? 'text-warn' : 'text-text'}>{tail}</span>
    </>
  );
}

/** A line with the search term marked. Falls back to the syntax colouring when nothing matches. */
function withSearch(line: string, needle: string, language: Language): ReactNode {
  if (!needle) return language === 'json' ? jsonLine(line) : yamlLine(line);
  const lower = line.toLowerCase();
  const target = needle.toLowerCase();
  if (!lower.includes(target)) return language === 'json' ? jsonLine(line) : yamlLine(line);
  // Highlighting wins over colouring on a matching line: the operator is looking for the term,
  // and painting both makes neither readable.
  const parts: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (;;) {
    const found = lower.indexOf(target, at);
    if (found === -1) break;
    if (found > at) parts.push(line.slice(at, found));
    parts.push(
      <mark key={n++} className="rounded-[2px] bg-accent/30 text-text">
        {line.slice(found, found + needle.length)}
      </mark>
    );
    at = found + needle.length;
  }
  if (at < line.length) parts.push(line.slice(at));
  return <span className="text-text">{parts}</span>;
}

export type Language = 'yaml' | 'json';

export function CodeViewer({
  /** Printed above the pane, verbatim. States which copy of the object this is. */
  label,
  text,
  language = 'yaml',
  /** Shown beside the label — document counts, byte sizes, a revision number. */
  meta,
  /** A note under the label, for the redaction sentence and similar caveats. */
  note,
  searchable = true,
  maxHeight = '560px',
  /** Extra controls in the header row — a revision picker, a compare toggle. */
  controls
}: {
  label: string;
  text: string;
  language?: Language;
  meta?: ReactNode;
  note?: ReactNode;
  searchable?: boolean;
  maxHeight?: string;
  controls?: ReactNode;
}): JSX.Element {
  const [needle, setNeedle] = useState('');
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => text.split('\n'), [text]);
  const matches = useMemo(() => {
    if (!needle.trim()) return null;
    const t = needle.toLowerCase();
    return lines.filter(l => l.toLowerCase().includes(t)).length;
  }, [lines, needle]);

  // A confirmation that clears itself. Left on screen it reads as a permanent state.
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1800);
      },
      () => setCopied(false)
    );
  };

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">{label}</span>
        {meta && <span className="mono text-[12px] text-muted">{meta}</span>}
        <span className="ml-auto flex items-center gap-2">
          {controls}
          {searchable && (
            <input
              type="search"
              value={needle}
              onChange={e => setNeedle(e.target.value)}
              placeholder="Search"
              aria-label={`Search ${label}`}
              className="h-7 w-[160px] rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text placeholder:text-muted"
            />
          )}
          {matches !== null && (
            <span className="mono text-[12px] text-muted">
              {matches} {matches === 1 ? 'line' : 'lines'}
            </span>
          )}
          <button
            type="button"
            onClick={copy}
            className="h-7 shrink-0 rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text hover:border-line-strong"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
      {note && <p className="mb-1.5 max-w-[100ch] text-[12px] text-muted">{note}</p>}
      <pre
        className="mono overflow-auto rounded-[6px] border border-line bg-raised p-3 text-[12px] leading-[1.6]"
        style={{ maxHeight }}
      >
        {lines.map((line, i) => (
          <div key={i}>{withSearch(line, needle.trim(), language)}</div>
        ))}
      </pre>
    </div>
  );
}

/**
 * Two panes side by side, with the differing lines marked.
 *
 * A line-level diff rather than a word-level one: Helm values and rendered manifests are
 * line-oriented, and a word diff over 400 lines of YAML produces confetti. The comparison is
 * positional — `left[i]` against `right[i]` — which is honest about what it is doing and never
 * claims a moved block is unchanged.
 */
export function CodeCompare({
  leftLabel,
  left,
  rightLabel,
  right,
  language = 'yaml',
  note,
  valueDelta,
  maxHeight = '520px'
}: {
  leftLabel: string;
  left: string;
  rightLabel: string;
  right: string;
  language?: Language;
  note?: ReactNode;
  /** Structured Helm values delta: gives additions/removals/edits stable, clickable paths. */
  valueDelta?: ValueDelta;
  maxHeight?: string;
}): JSX.Element {
  const l = useMemo(() => left.split('\n'), [left]);
  const r = useMemo(() => right.split('\n'), [right]);
  const changed = useMemo(() => {
    const n = Math.max(l.length, r.length);
    let count = 0;
    for (let i = 0; i < n; i += 1) if (l[i] !== r[i]) count += 1;
    return count;
  }, [l, r]);
  /*
    A token, not just a path: pressing the same chip again after scrolling away has to scroll back,
    and a path held in state would be unchanged, so the pane's effect would not run.
  */
  const [focus, setFocus] = useState<{ path: string; n: number } | null>(null);
  const jump = (path: string) => setFocus(prev => ({ path, n: (prev?.n ?? 0) + 1 }));

  // Memoised: a fresh `marks` array on every render would re-run the pane's scroll effect, so an
  // unrelated re-render would drag the pane back to the last chip the reader pressed.
  const delta = language === 'json' ? valueDelta : undefined;
  const leftMarks = useMemo(() => (delta ? valueDiffMarks(left, delta, 'left') : []), [delta, left]);
  const rightMarks = useMemo(() => (delta ? valueDiffMarks(right, delta, 'right') : []), [delta, right]);

  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-muted">
        {changed === 0 ? (
          'These two are identical, line for line.'
        ) : (
          <>
            <span className="mono text-text">{changed}</span> line{changed === 1 ? '' : 's'} differ. The comparison is
            positional, line by line — a block that moved reads as changed on both sides.
          </>
        )}
        {note && <> {note}</>}
      </p>
      {delta && (delta.added.length || delta.removed.length || delta.changed.length) ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Changed value paths">
          {delta.removed.map(path => <DiffPath key={`removed/${path}`} path={path} tone="removed" onClick={() => jump(path)} />)}
          {delta.added.map(path => <DiffPath key={`added/${path}`} path={path} tone="added" onClick={() => jump(path)} />)}
          {delta.changed.map(path => <DiffPath key={`changed/${path}`} path={path} tone="changed" onClick={() => jump(path)} />)}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ComparePane label={leftLabel} lines={l} other={r} side="left" language={language} maxHeight={maxHeight} marks={leftMarks} focus={focus} />
        <ComparePane label={rightLabel} lines={r} other={l} side="right" language={language} maxHeight={maxHeight} marks={rightMarks} focus={focus} />
      </div>
    </div>
  );
}

const CHIP: Record<DiffMark['tone'], { label: string; classes: string }> = {
  removed: { label: 'Removed', classes: 'border-bad/40 bg-bad/10 text-bad' },
  added: { label: 'Added', classes: 'border-ok/40 bg-ok/10 text-ok' },
  changed: { label: 'Changed', classes: 'border-warn/40 bg-warn/10 text-warn' }
};

/** Line tints. A structured mark reads stronger than the positional difference under it. */
const MARK_TINT: Record<DiffMark['tone'], string> = { removed: 'bg-bad/20', added: 'bg-ok/20', changed: 'bg-warn/20' };

function DiffPath({ path, tone, onClick }: { path: string; tone: DiffMark['tone']; onClick: () => void }): JSX.Element {
  const { label, classes } = CHIP[tone];
  return <button type="button" onClick={onClick} className={`rounded-[5px] border px-1.5 py-0.5 mono text-[11px] ${classes}`} title={`Jump to ${label.toLowerCase()} value ${path}`}>{label} · {path}</button>;
}

function ComparePane({
  label, lines, other, side, language, maxHeight, marks, focus
}: {
  label: string; lines: string[]; other: string[]; side: 'left' | 'right'; language: Language; maxHeight: string; marks: DiffMark[]; focus: { path: string; n: number } | null;
}): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const marked = useMemo(() => new Map(marks.map(mark => [mark.line, mark])), [marks]);
  // Each line is a direct child of the <pre>, in order, so the child at the mark's index is its line.
  useEffect(() => {
    const mark = focus && marks.find(item => item.path === focus.path);
    if (mark) preRef.current?.children[mark.line]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus, marks]);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">{label}</div>
      <pre ref={preRef} className="mono overflow-auto rounded-[6px] border border-line bg-raised p-3 text-[12px] leading-[1.6]" style={{ maxHeight }}>
        {lines.map((line, i) => {
          const mark = marked.get(i);
          const tint = mark ? MARK_TINT[mark.tone] : other[i] !== line ? (side === 'left' ? 'bg-bad/15' : 'bg-ok/15') : undefined;
          return <div key={i} className={tint && `-mx-1 rounded-[2px] px-1 ${tint}`}>{language === 'json' ? jsonLine(line) : yamlLine(line)}</div>;
        })}
      </pre>
    </div>
  );
}

/** A values object as the pane's text. One place, so JSON formatting cannot drift per screen. */
export function valuesText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
