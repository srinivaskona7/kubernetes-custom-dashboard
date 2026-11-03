import type { Trace, TracesData } from '../../api';
import { Dot, TONE_TEXT } from '../../components/ui';
import { edgeFactLines, pathEmptyLine, pathRows } from './journey-path';
import { hopStatus, CONNECTION_DURATION_TIP } from './journey-status';

const KIND_WORD = { edge: 'Client request', gateway: 'Gateway', workload: 'Service', external: 'External call', notRead: 'Not read' } as const;

/** The journey's path, top to bottom: exact links solid, inferred dashed with their count. */
export function JourneyPath({ trace, summary, onExplain }: { trace: Trace; summary: TracesData['summary'] | undefined; onExplain: (code: number) => void }) {
  const empty = pathEmptyLine(trace, summary);
  if (empty || !trace.journeyPath) return <p className="text-[13px] text-muted">{empty}</p>;
  const rows = pathRows(trace.journeyPath);
  return (
    <ol className="space-y-0">
      {rows.map(row => (
        <li key={row.node.id} className="min-w-0">
          {row.link && (
            <div className="flex items-center gap-2 pl-[7px]">
              <span aria-hidden="true" className={`h-5 border-l-2 ${row.link.link === 'inferred' && row.link.candidates === 0 ? 'border-dotted border-line' : row.dashed ? 'border-dashed border-line-strong' : 'border-solid border-line-strong'}`} />
              <span className="text-[11px] text-muted">{row.linkText}</span>
            </div>
          )}
          <div className={`flex min-w-0 items-baseline gap-2 rounded-[6px] px-2 py-1 ${row.failing ? 'bg-bad/5 ring-1 ring-bad' : 'bg-panel/20'}`}>
            <Dot tone={row.tone} />
            <span className={`shrink-0 text-[11px] ${TONE_TEXT[row.tone]}`}>{hopStatus(row.node).word}</span>
            <span className="w-[92px] shrink-0 text-[11px] uppercase tracking-[0.06em] text-muted">{KIND_WORD[row.node.kind]}</span>
            <span
              className="mono min-w-0 flex-1 truncate text-[12px]"
              title={row.node.ip && row.node.destination ? `${row.node.label} (${row.node.ip})` : row.node.label}
            >
              {row.node.label}
              {row.node.undeclared && row.node.ip && <span className="ml-1 text-warn">Undeclared</span>}
              {row.node.method && (
                <span className="ml-2 text-muted">
                  {row.node.method} {row.node.path}
                </span>
              )}
            </span>
            {row.node.code !== undefined && row.node.code !== null && (
              <button type="button" className="mono shrink-0 text-[12px] hover:underline" onClick={() => onExplain(row.node.code as number)}>
                {row.node.code === 0 ? 'none' : row.node.code}
              </button>
            )}
            <span className="mono shrink-0 text-right text-[11px] text-muted" title={row.node.kind === 'external' ? CONNECTION_DURATION_TIP : undefined}>
              {row.timing}
            </span>
          </div>
          {row.failing && row.node.flags && row.node.flags.length > 0 && <p className="pl-[108px] text-[11px] text-bad">flags {row.node.flags.join(', ')}</p>}
          {row.node.kind === 'edge' &&
            edgeFactLines(row.node).map(line => (
              <p key={line} className="truncate pl-[108px] text-[11px] text-muted">
                {line}
              </p>
            ))}
        </li>
      ))}
    </ol>
  );
}
