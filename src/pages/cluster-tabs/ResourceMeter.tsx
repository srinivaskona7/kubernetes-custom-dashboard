/**
 * The one used / request / limit meter, drawn in each CPU and Memory cell of the
 * Namespaces & Workloads → Namespaces table.
 *
 * Three quantities on one track, and the track is scaled to the largest of them so a namespace
 * running above its request still renders inside its box instead of clipping at the edge. The
 * request and the limit are **ticks**, not segments: they are ceilings to compare the fill against,
 * and drawing them as filled areas would read as consumption.
 *
 * The badge sits inline after the percentage and escalates on one ladder (`UsageLevel`): amber
 * outline for above request, a filled tint for near limit, solid red for at limit, where the limit
 * tick turns solid too. The badge is the only coloured text; the percentage stays in the body
 * colour. Colour is never the only carrier — every step has a word.
 *
 * With no request declared the fill is neutral, never green: there is nothing to be healthy
 * against. With neither a request nor a limit the track is drawn empty and dashed (`muted/80`, the
 * weakest token that holds 3:1 against the row in both themes; `line` is 1.4:1), because
 * `meterGeometry` would scale it to `used` and paint a full bar.
 */

import { cpu } from '../../format';
import {
  figuresText,
  meterGeometry,
  ofRequestText,
  pctOf,
  usageVerdict,
  type Figures,
  type UsageLevel,
  type UsageScope,
  type UsageTone,
  type UsageVerdict
} from './namespace-usage';
import { mem } from './usage/shared';

/** Local rather than imported: `ui.tsx` keeps its tone maps private, and these are the same four. */
const FILL: Record<UsageTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  unknown: 'bg-unknown'
};

function badgeClass(v: UsageVerdict): string {
  const level: UsageLevel = v.level;
  if (level === 'at-limit') return 'border-bad bg-bad text-white font-semibold';
  if (level === 'near-limit') {
    return v.tone === 'bad' ? 'border-bad/70 bg-bad/20 text-bad font-semibold' : 'border-warn/80 bg-warn/25 text-warn font-semibold';
  }
  if (level === 'above-request') return 'border-warn/40 bg-warn/10 text-warn font-medium';
  return 'border-line bg-raised text-muted font-medium';
}

/**
 * The table cell's caption: `used / request / limit`, unnamed so it fits the ~182px the column can
 * give on one line. The legend prints the same order as its key, and the named `figuresText` form
 * stays on the bar's tooltip and accessible value, so nothing the caption drops is hidden.
 */
function compactFigures(f: Figures, fmt: (n: number | null | undefined) => string): string {
  const lim = f.limit === null ? 'none' : `${f.limitPartial ? '≥' : ''}${fmt(f.limit)}`;
  return `${fmt(f.used)} / ${f.request === null ? 'none' : fmt(f.request)} / ${lim}`;
}

export function ResourceMeter({
  label,
  metric,
  figures,
  compact = false,
  scope = 'namespace'
}: {
  label: string;
  metric: 'cpu' | 'memory';
  figures: Figures;
  /** Table cells: the column header already names the resource, so the label is not printed. */
  compact?: boolean;
  /** Whose figures these are — wording only; the ladder is the same at every scope. */
  scope?: UsageScope;
}): JSX.Element {
  const g = meterGeometry(figures);
  const verdict = usageVerdict(metric, figures, scope);
  const fmt = metric === 'cpu' ? cpu : mem;
  const ofRequest = pctOf(figures.used, figures.request);
  const noRequest = figures.request === null && figures.used !== null;
  // Nothing declared at all: `meterGeometry` scales to `used`, so a fill would be a full bar.
  const noBudget = noRequest && figures.limit === null;
  const atLimit = verdict.level === 'at-limit';
  // Green means "inside the request"; with no request there is nothing to be inside of.
  const fill = noRequest && verdict.level === 'normal' ? 'bg-unknown/60' : FILL[verdict.tone];
  const figure = noRequest ? 'No request configured' : ofRequestText(figures, scope);
  const named = figuresText(figures, fmt);
  // `119%` + ` of request`, so the number can carry the weight and the denominator a size less.
  const share = /^(\S+%)( of request)$/.exec(figure);

  return (
    // `relative` so the compact mode's sr-only label (position: absolute) has a containing block
    // inside the table scroller; without one it resolves to the page and widens the document.
    // `text-left`: the CPU and Memory columns are numeric, so the cell right-aligns, and a caption
    // pushed right under a left-anchored bar reads ragged.
    <div className={compact ? 'relative w-full min-w-[180px] text-left' : 'relative'}>
      <div className={compact ? 'flex items-center' : 'flex items-center justify-between gap-2'}>
        {compact ? <span className="sr-only">{label}</span> : <span className="text-[12px] font-medium text-text">{label}</span>}
        {/* `flex-wrap` is the fallback only: the badge drops under the figure when the two cannot
            share ~182px, rather than widening the column (the table cell is `white-space: nowrap`). */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
          {/* Named denominator, and three distinct nothings rather than one em dash — see
              `ofRequestText`. Sans, with the denominator a size down: mono "119% of request" beside
              the badge needed 199px of the ~182 the cell has, and the badge wrapped on every
              above-request row. */}
          {/* Body colour in every state: the badge carries the tone, so amber is said once. */}
          <span className={`tabular-nums text-[12px] ${noRequest || verdict.tone === 'unknown' ? 'text-muted' : 'text-text'}`}>
            {share ? (
              <>
                <span className="font-medium">{share[1]}</span>
                <span className="text-[11px]">{share[2]}</span>
              </>
            ) : (
              figure
            )}
          </span>
          {verdict.label && (
            <span
              title={verdict.detail ?? undefined}
              className={`whitespace-nowrap rounded-[2px] border px-[3px] text-[11px] leading-[16px] ${badgeClass(verdict)}`}
            >
              {verdict.label}
            </span>
          )}
        </span>
      </div>
      {/* No `overflow-hidden`: the limit tick stands 2px proud of the track so it reads as a
          ceiling rather than another segment. The fill is at most 100%, so nothing else escapes.
          `line-strong/70`: on the card surface `raised` measured 1.14:1 and the empty part vanished;
          this holds ≥1.5:1 in both themes and keeps the amber fill ≥3:1 against it (`/80` does not).
          `mt-[5px]` pays for the 7px track: the meter block stays the height of a text-only row. */}
      <div
        className={`relative mt-[5px] h-[7px] w-full rounded-[3.5px] ${noBudget ? 'border border-dashed border-muted/80' : 'bg-line-strong/70'}`}
        role="meter"
        aria-valuenow={ofRequest ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${figure}; ${named}`}
        aria-label={`${label} usage against request`}
        title={`${label}: ${named}`}
      >
        {!noBudget && <div className={`absolute inset-y-0 left-0 rounded-[3.5px] ${fill}`} style={{ width: `${g.usedPct}%` }} />}
        {g.requestPct !== null && (
          <span
            aria-hidden
            title={`Requested ${fmt(figures.request)}`}
            className="absolute top-0 h-full w-px bg-text/60"
            style={{ left: `${g.requestPct}%` }}
          />
        )}
        {g.limitPct !== null && (
          <span
            aria-hidden
            title={`Limit ${figures.limitPartial ? 'at least ' : ''}${fmt(figures.limit)}`}
            className={`absolute -top-[2px] h-[11px] w-[2px] rounded-[1px] ${atLimit ? 'bg-bad' : 'bg-bad/60'}`}
            style={{ left: `calc(${g.limitPct}% - 1px)` }}
          />
        )}
      </div>
      {compact ? (
        <p className="mono mt-1 whitespace-nowrap text-[11px] leading-[14px] tracking-[-0.02em] text-muted">
          {compactFigures(figures, fmt)}
        </p>
      ) : (
        <p className="mono mt-1 text-[11px] leading-[14px] text-muted">{named}</p>
      )}
    </div>
  );
}

/**
 * The key beside a set of meters: what the fill and the two ticks mean, drawn as the meter draws
 * them, and slash-separated because it is also the order key for the compact caption's triple.
 */
export function MeterLegend(): JSX.Element {
  // Each key is a short track carrying the bar's own mark, so it reads as the bar does. The request
  // tick is 2px here against the bar's 1px: at 18px wide a single pixel is a hairline nobody finds.
  const track = 'relative inline-block h-[7px] w-[18px] rounded-[3.5px] bg-line-strong/70';
  return (
    <span className="flex items-center text-[11px] text-muted">
      <span className="inline-flex items-center gap-1">
        <span className={track}>
          <span className="absolute inset-y-0 left-0 w-[11px] rounded-[3.5px] bg-ok" />
        </span>
        used
      </span>
      <span className="whitespace-pre">{' / '}</span>
      <span className="inline-flex items-center gap-1">
        <span className={track}>
          <span className="absolute left-[8px] top-0 h-full w-[2px] bg-text/60" />
        </span>
        request
      </span>
      <span className="whitespace-pre">{' / '}</span>
      <span className="inline-flex items-center gap-1">
        <span className={track}>
          <span className="absolute -top-[2px] left-[14px] h-[11px] w-[2px] rounded-[1px] bg-bad/60" />
        </span>
        limit
      </span>
    </span>
  );
}
