/**
 * Traffic Errors → the partial-visibility banner.
 *
 * One claim: this page is not seeing the whole mesh, and here is exactly how much of it is missing.
 *
 * It is worth a component of its own because it is the sentence that decides how every other number on
 * the page should be read. Live, the collector caps its sweep and reads 10 of 41 observed proxies — so
 * "0 server errors" means "none in a quarter of the mesh over a 13-hour tail", and an operator who
 * reads it as "none in the mesh" will close the wrong incident.
 *
 * The decision rule lives in `visibilityNotice` and is tested there rather than here, because the thing
 * that matters about a warning is *when it fires*. It returns `null` only when there is genuinely
 * nothing to warn about — no window, no observed proxy, or every observed proxy read with no failure —
 * so this is never a banner that is always on, and never one that hides a real gap. Two wordings the
 * rule enforces and this file must not soften:
 *
 *  - **"read", never "reporting".** A proxy the collector never asked has not declined to answer.
 *  - **truncation is its own sentence.** Proxies that were read but had older lines beyond the tail are
 *    a shorter window, not a missing proxy, and adding the two counts together would produce a figure
 *    that describes neither.
 *
 * The `⚠` is a text-presentation glyph and is `aria-hidden`: the title beside it carries the meaning, so
 * the banner survives greyscale and a screen reader gets the sentence rather than "warning sign".
 */
import type { TrafficWindow } from '../../../api';
import { InfoPopover } from '../../../components/InfoPopover';
import { visibilityNotice } from './proxy-rollup';

export function VisibilityWarning({ window: w }: { window: TrafficWindow | undefined }): JSX.Element | null {
  const notice = visibilityNotice(w);
  if (!notice) return null;

  return (
    <div role="status" className="rounded-[8px] border border-warn/40 bg-warn/5 px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span aria-hidden="true" className="text-[13px] text-warn">
          ⚠
        </span>
        <span className="text-[13px] font-semibold text-text">{notice.title}</span>
        <InfoPopover
          ariaLabel="Explain partial traffic visibility and what it does to the counts on this page"
          content={{
            title: notice.title,
            means:
              'This page counts what it read. The collector tails a bounded number of proxies per request, so the proxies it did not read contribute nothing to any count here — including the zeros.',
            source: (
              <>
                The per-read accounting on <span className="mono">window</span>: observed proxies, proxies
                read, proxies not read, and the reads that failed.
              </>
            ),
            limitations: [
              'A proxy that was not read was never asked. Its absence is a statement about this read’s budget, not about that proxy.',
              'The proxies that were not read cannot be named — the payload carries a count and no identities.',
              'A zero on this page means "none in what was read". It is not evidence that none occurred.',
              'Truncated proxies are a separate gap: those were read, but only their most recent lines. Widening the tail changes that number and not the proxies-read one.'
            ],
            sources: ['accessLog']
          }}
        />
      </div>
      <p className="mt-1 max-w-[100ch] text-[13px] text-muted">{notice.message}</p>
      {notice.truncatedNote && (
        // A second paragraph rather than a clause: one number is missing proxies and the other is a
        // shorter window, and a reader who skims them as one figure has understood neither.
        <p className="mt-1 max-w-[100ch] text-[13px] text-muted">{notice.truncatedNote}</p>
      )}
    </div>
  );
}
