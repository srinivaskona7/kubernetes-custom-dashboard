/**
 * The one control that is OPA's own: a clickable finding row.
 *
 * The filter bar, select and search box that used to live here are shared with Top Utilization now
 * and moved to `components/filters.tsx`. This is inspection-only: it changes where you are looking,
 * and sends nothing to the cluster.
 */
import type { Finding } from '../../../findings';
import { SEVERITY_TONE, useFindingNavigation } from '../../../findings';
import { Dot } from '../../../components/ui';

/**
 * One finding, as a full-width row button.
 *
 * A button rather than a div-with-onClick because it is genuinely actionable and has to be
 * reachable by keyboard; the severity reaches a screen reader as a word, never as a colour. A row,
 * not a card: the findings are grouped with dividers (density 8), and the dot shares the text's
 * baseline so a finding with no count never leaves a lone dot on its own line.
 */
export function FindingRow({ finding }: { finding: Finding }): JSX.Element {
  const go = useFindingNavigation();
  const tone = SEVERITY_TONE[finding.severity];
  return (
    <button
      type="button"
      onClick={() => go(finding.destination)}
      className="flex w-full items-baseline gap-3 py-2.5 text-left transition-colors hover:bg-raised"
      title="Show the rows behind this finding"
    >
      <Dot tone={tone} />
      <span className="sr-only">{finding.severity}: </span>
      {finding.affectedCount !== null && (
        <span className={`mono text-[15px] font-semibold ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-text'}`}>
          {finding.affectedCount}
        </span>
      )}
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-text">{finding.summary}</span>
      <span className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2 text-[12px] text-muted">
        <span className="mono">{finding.source}</span>
        {finding.freshness && (
          <span
            tabIndex={-1}
            title={finding.freshness.detail}
            className={finding.freshness.state === 'fresh' ? '' : 'text-warn'}
          >
            · evidence {finding.freshness.state}
          </span>
        )}
      </span>
    </button>
  );
}
