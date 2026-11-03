/**
 * What a usage-against-its-declaration figure actually risks — CPU and memory judged apart.
 *
 * ## Why this module exists
 *
 * The Top pods table used to render `222% of request` in warning yellow whether the resource was
 * CPU or memory, and operators read that as a pod about to die. It is not, and the two cases are not
 * comparable:
 *
 *  - **CPU is compressible.** A request is a scheduling floor, not a ceiling; using 222% of a CPU
 *    request borrows idle cycles from the node and kills nothing. At a CPU *limit* the kernel makes
 *    the container wait (CFS quota) — latency, not termination.
 *  - **Memory is incompressible.** There is no throttling step. Reaching the memory *limit* gets the
 *    container terminated by the kernel: OOMKilled, exit code 137.
 *
 * So one number cannot carry one colour. `assessResourceRisk` is the single place that decides, and
 * it is pure so it can be tested — `app/fleet-ui` runs vitest with `environment: 'node'` and there is
 * no DOM renderer available, which is also why every helper the panel needs lives here rather than
 * in the JSX beside it.
 *
 * ## What it does not claim
 *
 * Consistent with `resourcePressure()` in `utilization-model.ts`:
 *
 *  - It never infers an OOMKill from a usage figure. `critical` says the container is *close to* the
 *    limit and what the kernel does if it arrives there. Whether one has happened is pod status, and
 *    only the `oom-killed` pressure finding reports it.
 *  - **Every badge derived from a threshold this console chose is marked `heuristic`** — `OOMKill Risk`,
 *    `High Memory` and `CPU Throttled`. That is what `basis` means, and it is deliberately the same
 *    meaning `resourcePressure()` gives the dashed border on `memory-critical` and `memory-near-limit`:
 *    Kubernetes defines no near-limit state, so 90%, 80% and 95% are all our lines rather than its.
 *    Marking only CPU would have put two meanings on one visual on one row — a pod at 92% of its memory
 *    limit would show a dashed `Critical proximity to memory limit` beside a solid `OOMKill Risk`.
 *  - `Bursting` and `Above Request` stay `measured`, and that is what keeps the distinction worth
 *    anything: `usage > request` invents no threshold, it is a plain comparison against a number
 *    somebody declared. If everything were heuristic the marker would say nothing.
 *  - The border carries "we chose the line"; `basisNote` carries anything further. `CPU Throttled` needs
 *    the extra sentence because it is the one badge whose *mechanism* is also unobservable here.
 *  - Thresholds are shared with `utilization-model.ts` rather than restated, so a cell's colour and
 *    its verdict cannot disagree.
 */
import { bytes, cpu } from '../../../format';
import { MEMORY_CRITICAL_FRACTION, MEMORY_NEAR_FRACTION } from './utilization-model';

/**
 * How close to the CPU limit counts as throttled.
 *
 * Tighter than the memory fractions (0.95 against 0.90) because the consequence is milder and
 * recoverable: a container at 85% of its CPU limit is fine, and warning there would spend the
 * operator's attention on something that costs nothing.
 */
export const CPU_THROTTLE_FRACTION = 0.95;

/**
 * Why the two memory badges wear the dashed border.
 *
 * The consequence *at* a memory limit is a kernel guarantee — the container is killed, no prediction
 * involved. Where this console starts warning about it is not: 90% and 80% are our lines. That is the
 * one thing the dashed border means, and `resourcePressure()` has meant it since before this module
 * existed, in the same words.
 */
export const MEMORY_THRESHOLD_NOTE =
  'The 90% and 80% lines are chosen by this console — Kubernetes defines no "near limit" state, so a ' +
  'container is either within its limit or already killed. What happens at the limit is a kernel guarantee; ' +
  'where the warning starts is our judgement.';

/**
 * Why `CPU Throttled` wears the dashed border, and the one thing it adds to the others.
 *
 * Exported so the panel prints this sentence rather than writing its own: the whole value of the
 * dashed border is that it means one thing everywhere, and a second paraphrase of the reason is how
 * that stops being true. The first half is the shared meaning — we chose the line. The second half is
 * this badge alone: its *mechanism* is unobservable here, not just its threshold.
 */
export const CPU_THROTTLE_NOTE =
  'The 95% line is chosen by this console — Kubernetes defines no "near the CPU limit" state. Beyond that, ' +
  'throttling itself is not something this console can see: CFS throttling depends on the burst pattern inside ' +
  'each 100ms period, so a container at this level may be throttled constantly or not at all, and this fleet ' +
  'exposes no container_cpu_cfs_throttled_periods_total counter to settle it.';

export type RiskLevel = 'critical' | 'warning' | 'info' | 'normal';

/**
 * Whether the line was Kubernetes' or ours.
 *
 * `heuristic` — the badge fires at a threshold **this console chose**. `OOMKill Risk`, `High Memory`
 * and `CPU Throttled` are all of these: Kubernetes defines no near-limit state at all, so 90%, 80% and
 * 95% are our judgement about when an operator should look. This is deliberately the same meaning
 * `resourcePressure()` gives `PressureFinding.basis`, because the dashed border is already shipped with
 * that meaning on other surfaces and one visual cannot carry two.
 *
 * `measured` — a plain comparison against a declared number, with no threshold of ours in it.
 * `Bursting` and `Above Request` are these: `usage > request` is arithmetic, not a choice. Keeping them
 * unmarked is what stops the marker collapsing into decoration.
 *
 * Note what `basis` is *not*: it does not say how certain the consequence is. Reaching a memory limit
 * really does kill the container, and `OOMKill Risk` is marked anyway — because the claim the badge
 * makes is "you should look now", and that part is ours. Where a badge has a second kind of
 * uncertainty, {@link RiskAssessment.basisNote} carries it; `CPU Throttled` is the only one that does.
 *
 * Marked on the assessment rather than derived at the render site so the claim and its provenance
 * cannot come apart, and so the mapping is unit-testable.
 */
export type RiskBasis = 'measured' | 'heuristic';

export interface RiskAssessment {
  level: RiskLevel;
  /** The short words on the cell or pill. Never a bare code, never an emoji. */
  badge: string;
  /** The panel headline: what state this is, in one line. */
  title: string;
  /** What it means for the workload — the half operators get wrong without it. */
  impactText: string;
  /** What to do, naming the field in the pod spec where it is done. */
  recommendation: string;
  /** See {@link RiskBasis}. Drives the dashed border marking a threshold this console chose. */
  basis: RiskBasis;
  /** Why the basis is what it is. Non-null exactly when `basis` is `heuristic`. */
  basisNote: string | null;
}

/**
 * A declared request or limit, or `null` when none was declared.
 *
 * `0` is how the wire spells "unset" (see `utilization-model.ts`), and so is `null`; both arrive.
 * Non-finite and negative values are not declarations either — they are a bug upstream, and honouring
 * one would produce a verdict from a basis that does not exist.
 */
function declaredOrNull(v: number | null): number | null {
  if (v === null || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/** A sample, or `null` when the number is not one. A negative or NaN usage supports no verdict. */
function sampleOrNull(v: number): number | null {
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

const NORMAL: RiskAssessment = {
  level: 'normal',
  badge: 'Within declarations',
  title: 'Nothing here crosses a threshold',
  impactText:
    'The current sample is inside whatever this container declares, or it declares nothing to compare ' +
    'against. Either way there is no resource risk this console can support claiming from it.',
  recommendation: 'No action. A container without a declared request or limit is a configuration choice, not a fault.',
  basis: 'measured',
  basisNote: null
};

const MEMORY_CRITICAL: RiskAssessment = {
  level: 'critical',
  badge: 'OOMKill Risk',
  title: 'Within 10% of the hard memory limit',
  impactText:
    'Memory is incompressible: there is no throttling step before termination. This container is within ' +
    '10% of the memory limit it declares, and if usage reaches that limit the kernel terminates it — an ' +
    'OOMKill, exit code 137 — and Kubernetes restarts it, losing whatever was in flight.',
  recommendation:
    'Raise resources.limits.memory to above the workload’s real peak, or investigate a memory leak if the ' +
    'figure keeps climbing between restarts. A container does not slow down first, so there is no warning ' +
    'after this one.',
  basis: 'heuristic',
  basisNote: MEMORY_THRESHOLD_NOTE
};

const MEMORY_WARNING: RiskAssessment = {
  level: 'warning',
  badge: 'High Memory',
  title: 'Past 80% of the memory limit',
  impactText:
    'Less than a fifth of the declared memory ceiling is left, and memory gives no throttling step before ' +
    'termination — an ordinary traffic spike can cross the limit and get the container OOMKilled.',
  recommendation:
    'Compare resources.limits.memory against what this workload actually peaks at. If this is its ordinary ' +
    'working level, the limit is set too close to it and should be raised.',
  basis: 'heuristic',
  basisNote: MEMORY_THRESHOLD_NOTE
};

const MEMORY_INFO: RiskAssessment = {
  level: 'info',
  badge: 'Above Request',
  title: 'Above its memory request, with no limit declared',
  impactText:
    'This container declares no memory limit, so nothing caps it and it cannot be killed for exceeding one. ' +
    'It can instead grow until the node runs short, and then the kubelet evicts pods on that node to reclaim ' +
    'memory — a pod above its request is evicted before one inside it.',
  recommendation:
    'Set resources.limits.memory so the consequence of a leak is this container rather than its node, and raise ' +
    'resources.requests.memory to what the workload really uses so eviction ranks it fairly.',
  basis: 'measured',
  basisNote: null
};

const CPU_WARNING: RiskAssessment = {
  level: 'warning',
  badge: 'CPU Throttled',
  title: 'At its CPU limit, where throttling is likely',
  impactText:
    'CPU is compressible. A container capped by the CFS quota waits rather than dying: requests queue, latency ' +
    'spikes and responses slow down, but the container is not terminated and no OOMKill follows from CPU. ' +
    'Whether it is actually being throttled at this moment is not something this console can see — see the note ' +
    'on the marker.',
  recommendation:
    'Raise resources.limits.cpu, or scale the workload horizontally so each replica needs less. If the latency ' +
    'is acceptable, this is a deliberate cap and needs nothing.',
  basis: 'heuristic',
  basisNote: CPU_THROTTLE_NOTE
};

const CPU_INFO: RiskAssessment = {
  level: 'info',
  badge: 'Bursting',
  title: 'Bursting above its CPU request',
  impactText:
    'A CPU request is a scheduling floor, not a ceiling. This container is using idle cycles its node has spare, ' +
    'which is safe and normal — exceeding a request throttles nothing and kills nothing. The request only becomes ' +
    'binding when the node is contended, and then this container is held back to the share it asked for.',
  recommendation:
    'Nothing, if this is occasional. If the container lives above its request, raise resources.requests.cpu to what ' +
    'it actually needs so the scheduler reserves it and a busy node cannot take it away.',
  basis: 'measured',
  basisNote: null
};

/**
 * A limit below the request, which the panel must not silently convert into a verdict about the request.
 *
 * Legal on the wire and real: these figures are pod-level sums, so one container declaring no limit
 * while its siblings do makes the pod's limit total smaller than its request total. It is also a genuine
 * misconfiguration at container level. Either way the limit is the number the kernel enforces, so the
 * verdict is taken from it — and this sentence is appended so the operator is not left comparing a
 * percentage against a basis that is itself wrong.
 */
const INVERTED_NOTE =
  ' The declared limit here is below the declared request, so the request cannot be honoured in full: either a ' +
  'container in this pod declares no limit while others do, or the two fields disagree. Fix that before reading ' +
  'the percentages as a capacity signal.';

function withInvertedNote(a: RiskAssessment): RiskAssessment {
  return { ...a, impactText: a.impactText + INVERTED_NOTE };
}

/**
 * What a container's current sample risks, given what it declares.
 *
 * @param unit which resource — the whole reason this function exists, since the two are not comparable
 * @param usage the current sample, in cores or bytes
 * @param request the declared request; `null` or `0` mean none was declared
 * @param limit the declared limit; `null` or `0` mean none was declared
 */
export function assessResourceRisk(
  unit: 'cpu' | 'memory',
  usage: number,
  request: number | null,
  limit: number | null
): RiskAssessment {
  const sample = sampleOrNull(usage);
  const req = declaredOrNull(request);
  const lim = declaredOrNull(limit);
  if (sample === null) return NORMAL;
  const inverted = req !== null && lim !== null && lim < req;
  const note = (a: RiskAssessment) => (inverted && a.level !== 'normal' ? withInvertedNote(a) : a);

  if (unit === 'memory') {
    if (lim !== null) {
      if (sample >= MEMORY_CRITICAL_FRACTION * lim) return note(MEMORY_CRITICAL);
      if (sample >= MEMORY_NEAR_FRACTION * lim) return note(MEMORY_WARNING);
      // Above the request but far from the limit is Burstable QoS working as designed. The only
      // remaining hazard is node-level eviction, and this tab has no node pressure reading to
      // support raising it here.
      return NORMAL;
    }
    if (req !== null && sample > req) return MEMORY_INFO;
    return NORMAL;
  }

  if (lim !== null && sample >= CPU_THROTTLE_FRACTION * lim) return note(CPU_WARNING);
  if (req !== null && sample > req) return note(CPU_INFO);
  return NORMAL;
}

/* ------------------------------------------------------------------- panel content */

/** One labelled figure in the inspection panel. `value` is already formatted. */
export interface RiskFact {
  label: string;
  value: string;
  /** Present when the figure has a percentage against it, e.g. `222% of request`. */
  note?: string;
}

/** The percentage of a basis, at the precision the rest of this tab uses. */
function pctOf(sample: number, basis: number): string {
  const p = (sample / basis) * 100;
  if (p >= 100) return `${Math.round(p)}%`;
  if (p >= 10) return `${p.toFixed(0)}%`;
  return `${p.toFixed(1)}%`;
}

/**
 * The three figures the panel states before it explains anything.
 *
 * "No limit configured" and "No request configured" are spelled out rather than shown as an em-dash:
 * this panel exists to be read by somebody deciding whether to edit a pod spec, and the absence of a
 * limit is the most decision-relevant thing on it.
 */
export function riskFacts(unit: 'cpu' | 'memory', usage: number, request: number | null, limit: number | null): RiskFact[] {
  const fmt = unit === 'cpu' ? cpu : bytes;
  const sample = sampleOrNull(usage);
  const req = declaredOrNull(request);
  const lim = declaredOrNull(limit);
  const facts: RiskFact[] = [
    { label: 'Current usage', value: sample === null ? 'No sample' : fmt(sample) }
  ];
  facts.push(
    req === null
      ? { label: 'Request', value: 'No request configured' }
      : {
          label: 'Request',
          value: fmt(req),
          ...(sample === null ? {} : { note: `${pctOf(sample, req)} of request` })
        }
  );
  facts.push(
    lim === null
      ? { label: 'Limit', value: 'No limit configured' }
      : {
          label: 'Limit',
          value: fmt(lim),
          ...(sample === null ? {} : { note: `${pctOf(sample, lim)} of limit` })
        }
  );
  return facts;
}
