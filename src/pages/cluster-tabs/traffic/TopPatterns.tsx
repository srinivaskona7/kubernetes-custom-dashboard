/**
 * Traffic Errors → the top failure patterns.
 *
 * A compact slice of the failures table: the few grouped patterns that account for the most records,
 * so the operator does not have to sort 430 rows to find the five that matter. Clicking one hands the
 * group back to the shell, which narrows the filters to it — a click here never acts on the cluster.
 *
 * ## The wording is deliberate
 *
 * "Observed request pattern", never anything that reads as a motive. A repeated `403` on
 * `/.env` or `/wp-login.php` is a path somebody asked for and a code Envoy returned, and that is the
 * whole of what this data supports. Calling it an attack, a scan or a probe would be this console
 * inventing intent from a string — the same class of claim as deriving "Not routed" from an empty
 * upstream, which the contract for this page forbids for the same reason.
 *
 * The section is optional in the request's own words, so it renders nothing rather than an empty
 * panel when there is nothing in view: the failures table directly below already states why it is
 * empty, and a second "no patterns" heading above it is noise at this density.
 */
import type { TrafficErrorGroup } from '../../../api';
import { InfoPopover } from '../../../components/InfoPopover';
import { topPatterns } from './metrics-logic';

/**
 * How many rows to show.
 *
 * Five, because the point is the shape of the window rather than a second copy of the table. The
 * caption states the slice against the total in view, so the number is never mistaken for all of it.
 */
const LIMIT = 5;

export function TopPatterns({
  groups,
  onPick
}: {
  groups: readonly TrafficErrorGroup[];
  onPick: (g: TrafficErrorGroup) => void;
}): JSX.Element {
  const rows = topPatterns(groups, LIMIT);
  if (rows.length === 0) return <></>;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-1.5">
          <h2 className="text-[14px] font-semibold uppercase tracking-[0.04em] text-text">Top failure patterns</h2>
          <InfoPopover
            content={{
              title: 'Top failure patterns',
              means:
                'The grouped request patterns with the most records in this window. One pattern is one combination of response code, method, path, host and upstream information.',
              source: 'The same grouped failures as the table below, ordered by their record count.',
              limitations: [
                'A pattern describes requests that were observed. It says nothing about intent — a repeated path and a repeated code are not evidence of a scan, an attack or a probe, and this page will not label them as one.',
                'Ordered by count within the rows currently in view, so changing a filter changes this list.',
                'A large count is not automatically a fault. A host rejecting unauthenticated callers produces exactly this shape.'
              ],
              sources: ['accessLog']
            }}
            ariaLabel="Explain top failure patterns"
          />
        </div>
        <p className="text-[13px] text-muted">
          {rows.length} of {groups.length.toLocaleString()} patterns in view, by record count
        </p>
      </div>

      {/* `divide-y` rather than a card each: five rows of four short facts is a list, and five cards
          would be five containers for the same information. */}
      <div className="divide-y divide-line">
        {rows.map(g => (
          <button
            key={g.key}
            type="button"
            onClick={() => onPick(g)}
            title={`Observed request pattern — ${g.count.toLocaleString()} record${g.count === 1 ? '' : 's'} in this window. Click to filter the failures to it.`}
            aria-label={`Filter to the observed request pattern ${g.method ?? 'no method'} ${g.path ?? 'no path'} answered ${g.code === 0 ? 'with no HTTP response' : `HTTP ${g.code}`} — ${g.count.toLocaleString()} records`}
            className="flex w-full items-center gap-3 rounded-[4px] py-2 text-left transition-colors hover:bg-raised/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <span className="mono w-[64px] shrink-0 text-right text-[13px] font-medium">
              {g.count.toLocaleString()}
            </span>
            {/* `none` for response_code 0, matching the breakdown above and the failures table — the
                same records are labelled the same way wherever they appear. */}
            <span className="mono w-[52px] shrink-0 text-[13px]">{g.code === 0 ? 'none' : g.code}</span>
            <span className="min-w-0 flex-1 truncate">
              {g.method && <span className="mono text-[12px] text-muted">{g.method} </span>}
              <span className="mono text-[12px]">
                {g.path ?? <span className="text-muted/70">no path recorded</span>}
              </span>
            </span>
            <span
              className="mono w-[180px] shrink-0 truncate text-right text-[12px] text-muted"
              title={g.authority ?? 'Envoy recorded no Host header on these requests.'}
            >
              {g.authority ?? '—'}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
