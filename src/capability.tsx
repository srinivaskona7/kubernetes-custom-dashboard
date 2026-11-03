/**
 * How a capability verdict reaches the screen.
 *
 * The backend already decides *what* each feature can answer and produces the exact sentence
 * (`srv/fleet/capability.js`). This module's whole job is to make that verdict impossible to
 * render dishonestly:
 *
 *  - `capabilityStatus()` converts a verdict into the `MetricStatus` the console's existing
 *    `<Count>`, `<MetricValue>` and `<StatTile>` already speak, so an untrusted verdict renders as
 *    `Unavailable` through the same code path that has always drawn it. No new component, and no
 *    screen can opt out by forgetting to check a flag.
 *  - `<CapabilityNotice>` prints the sentence, verbatim, above the pane it applies to.
 *  - `<CapabilityBadge>` is the one-word version for a tab strip or a table cell.
 *
 * The rule these three enforce together: a feature the cluster would not or could not answer never
 * appears as an empty table or a zero. `not-installed` is the single state where the count beside it
 * IS a fact, and it is the only one marked trusted alongside `available` and `stale`.
 */
import type { Capability, CapabilityState } from './api';
import type { MetricStatus } from './components/unavailable';
import { Dot, Pill, type Tone } from './components/ui';

const TONE: Record<CapabilityState, Tone> = {
  available: 'ok',
  // A number that is real but frozen. Warn rather than bad: the digits are correct, their age is not.
  stale: 'warn',
  partial: 'warn',
  // The three that need someone to change something. Bad, because an operator reading a governance
  // screen that cannot see its own policies is looking at a broken control, not a degraded one.
  forbidden: 'bad',
  'not-configured': 'warn',
  'unsupported-backend': 'bad',
  // Absent is not a fault. The cluster does not have the feature, the zero is true, and spending
  // the alarm colour here would blunt it where it means a dead credential.
  'not-installed': 'unknown',
  unknown: 'unknown'
};

export function capabilityTone(state: CapabilityState): Tone {
  return TONE[state] ?? 'unknown';
}

/**
 * A capability verdict as a `MetricStatus`, so the existing count components render it.
 *
 * The mapping is the honesty rule in three lines: an untrusted verdict becomes `unavailable`, which
 * makes `<Count>` draw an em-dash and the word UNAVAILABLE instead of the number it was handed.
 * `partial` and `stale` keep their numbers and carry the caveat. `not-installed` is `ok` on purpose
 * — the feature is genuinely absent and 0 is the right answer.
 */
export function capabilityStatus(capability: Capability | null | undefined, what?: string): MetricStatus {
  if (!capability) {
    return { state: 'ok', what: what || '', why: '', blind: 0, total: 1, truncated: false, truncatedWhy: '' };
  }
  const noun = what || capability.feature;
  const why = capability.sentence || '';
  if (capability.state === 'available' || capability.state === 'not-installed') {
    return { state: 'ok', what: noun, why: '', blind: 0, total: 1, truncated: false, truncatedWhy: '' };
  }
  if (!capability.trusted) {
    return { state: 'unavailable', what: noun, why, blind: 1, total: 1, truncated: false, truncatedWhy: '' };
  }
  return { state: 'partial', what: noun, why, blind: 0, total: 1, truncated: false, truncatedWhy: '' };
}

/** True when a number may be printed beside this verdict. */
export function isTrusted(capability: Capability | null | undefined): boolean {
  return !capability || capability.trusted;
}

export function CapabilityBadge({ capability }: { capability: Capability }): JSX.Element | null {
  if (capability.state === 'available') return null;
  return <Pill tone={capabilityTone(capability.state)}>{capability.label}</Pill>;
}

/**
 * The verdict, in the operator's words, above the pane it governs.
 *
 * `sentence` is printed verbatim rather than rebuilt here: the same feature must be explained the
 * same way on every screen, and the one place that knows the whole picture is the collector that
 * made the reads. `detail` is the raw API message and sits below in a smaller voice — an RBAC denial
 * names the exact missing rule, which is the difference between "ask for access" and "add
 * `cert-manager.io` to the reader role".
 */
export function CapabilityNotice({
  capability,
  className = ''
}: {
  capability: Capability | null | undefined;
  className?: string;
}): JSX.Element | null {
  if (!capability || capability.state === 'available' || !capability.sentence) return null;
  const tone = capabilityTone(capability.state);
  return (
    <div
      className={`rounded-[8px] border border-line bg-raised px-4 py-3 ${className}`}
      role={tone === 'bad' ? 'alert' : undefined}
    >
      <p className="flex items-start gap-2 text-[13px] text-text">
        <span className="mt-[6px]">
          <Dot tone={tone} />
        </span>
        <span className="max-w-[110ch]">
          <span className="font-medium">{capability.label}.</span> {capability.sentence}
        </span>
      </p>
      {capability.detail && (
        <p className="mono mt-1.5 max-w-[110ch] pl-4 text-[12px] text-muted">{capability.detail}</p>
      )}
      {capability.missing.length > 0 && (
        <p className="mt-1.5 pl-4 text-[12px] text-muted">
          Reads that did not complete: <span className="mono text-text">{capability.missing.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The body of an empty pane whose emptiness is not a fact.
 *
 * Distinct from a designed empty state, and the distinction is the point: "no violations" and "we
 * could not read the violations" look identical as an empty table, and only one of them is good
 * news. This renders the second so it can never be mistaken for the first.
 */
export function CapabilityEmpty({ capability }: { capability: Capability }): JSX.Element {
  return (
    <div className="py-8 text-center">
      <p className="flex items-center justify-center gap-2 text-[14px] font-medium text-text">
        <Dot tone={capabilityTone(capability.state)} />
        {capability.label}
      </p>
      <p className="mx-auto mt-1.5 max-w-[80ch] text-[13px] text-muted">{capability.sentence}</p>
      {capability.detail && <p className="mono mx-auto mt-1.5 max-w-[80ch] text-[12px] text-muted">{capability.detail}</p>}
    </div>
  );
}
