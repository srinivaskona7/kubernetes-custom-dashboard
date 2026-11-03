/**
 * One vocabulary for "can this feature answer, and if not, why".
 *
 * Every collector already degrades instead of throwing (`safe-list.js`), so each read comes back
 * carrying `unavailable` + a reason code, or `absent` when a discovery probe confirmed the API group
 * is not registered. That is the raw material. What it is NOT is an answer to the question an
 * operator actually asks — *"is this screen telling me the truth?"* — because the same empty table
 * can mean six different things:
 *
 *   the cluster is clean            0 is the honest answer
 *   the CRD is not installed        0 is the honest answer, for a different reason
 *   this token lacks the RBAC       0 is a LIE and the fix is a role binding
 *   the telemetry is not wired      0 is a lie and the fix is a controller flag
 *   the data is old                 the number was true, an hour ago
 *   the storage backend is not ours the number cannot be produced from here at all
 *
 * This module collapses those into one named state per feature, each carrying the exact sentence the
 * UI prints. The sentence is part of the contract, not a UI concern: an operator who reads
 * "unavailable" learns nothing, and an operator who reads "the read-only service account cannot
 * access the configured Helm Secret storage" knows precisely which of the six they are in and who
 * has to fix it.
 *
 * ## The one rule
 *
 * A missing permission never becomes an empty result and never becomes a healthy one. `forbidden`
 * and `not-installed` are different states with different sentences, and neither is `available`
 * with a count of zero. Where the evidence does not settle which one applies, the answer is
 * `unknown` — an eighth state on purpose, because guessing between "absent" and "refused" is how a
 * governance console tells its most expensive lie.
 *
 * ## Read-only
 *
 * Capability is inferred from the responses to reads the collector was making anyway. There is no
 * SelfSubjectAccessReview here and there must not be: a SSAR is a POST, this application performs
 * no writes against a cluster, and the repo's grep guard over `server/fleet` enforces it. A 403 on the
 * real read is better evidence than a permission check anyway — it is the answer to the exact
 * question, at the exact moment, for the exact object.
 */

/**
 * The states, in the order a UI should rank them when several features disagree — worst first.
 *
 * `label` is the operator-facing name; `trusted` says whether a count carried alongside this state
 * may be read as a fact. Only `available` and `stale` carry real numbers, and `stale` needs its
 * timestamp shown beside them.
 */
const STATES = {
  forbidden: { label: 'Forbidden by RBAC', trusted: false, rank: 0 },
  'unsupported-backend': { label: 'Unsupported storage backend', trusted: false, rank: 1 },
  'not-configured': { label: 'Data source not configured', trusted: false, rank: 2 },
  unknown: { label: 'Unknown', trusted: false, rank: 3 },
  'not-installed': { label: 'API/CRD not installed', trusted: true, rank: 4 },
  partial: { label: 'Partially available', trusted: false, rank: 5 },
  stale: { label: 'Data stale', trusted: true, rank: 6 },
  available: { label: 'Available', trusted: true, rank: 7 }
};

/** Reason codes from `safe-list.js` that mean the credential, not the cluster, is the problem. */
const ACCESS_REASONS = new Set(['FORBIDDEN', 'UNAUTHORIZED']);

/** What each `safeList` reason code means in a sentence, as a clause after "because". */
const REASON_CLAUSE = {
  FORBIDDEN: 'the read-only service account cannot access',
  UNAUTHORIZED: 'this cluster rejected the console’s credential for',
  RATE_LIMITED: 'the cluster rate-limited the read of',
  TIMEOUT: 'the read did not complete in time for',
  UPSTREAM: 'the cluster returned an error reading'
};

/**
 * One feature's capability.
 *
 * @param {object} spec
 * @param {string} spec.feature   operator-facing feature name, used verbatim in `sentence`
 * @param {keyof STATES} spec.state
 * @param {string|null} [spec.cause] the clause after "because" / after the colon; already a
 *   complete phrase, lower-case, no trailing period
 * @param {string|null} [spec.detail] the raw evidence — an API message, a probe result
 * @param {string[]} [spec.missing] labels of the specific reads that could not be performed
 * @param {object} [spec.extra] state-specific facts (backend name, staleness age, …)
 * @param {string} [spec.sentence] override the generated sentence, for a feature whose name does
 *   not read grammatically in the default template ("values ARE unavailable")
 */
function capability({ feature, state, cause = null, detail = null, missing = [], extra = null, sentence }) {
  const meta = STATES[state] || STATES.unknown;
  return {
    feature,
    state: STATES[state] ? state : 'unknown',
    label: meta.label,
    /** True when a number shown beside this state is a fact rather than a placeholder. */
    trusted: meta.trusted,
    cause,
    detail,
    missing: Array.isArray(missing) ? missing.filter(m => typeof m === 'string' && m) : [],
    /**
     * The exact sentence the UI prints. Built here rather than in the UI so that the same feature
     * cannot be explained two different ways on two different screens, and so a new consumer gets
     * the wording right by default instead of inventing a vaguer one.
     */
    sentence: sentence !== undefined ? sentence : sentenceFor(feature, state, cause),
    ...(extra ? { extra } : {})
  };
}

function sentenceFor(feature, state, cause) {
  if (state === 'available') return null;
  if (!cause) {
    // No cause is itself a fact worth stating plainly rather than papering over.
    return `${feature} is unavailable and this console could not determine why.`;
  }
  if (state === 'partial') return `${feature} is partially available: ${cause}.`;
  if (state === 'stale') return `${feature} data is stale: ${cause}.`;
  if (state === 'not-installed') return `${feature} is unavailable because ${cause}.`;
  return `${feature} is unavailable because ${cause}.`;
}

/** A feature that answered in full. */
function available(feature, extra) {
  return capability({ feature, state: 'available', extra });
}

/**
 * Classify a feature from the reads that produce it.
 *
 * The precedence is deliberate and is the whole logic of the module:
 *
 *  1. **Access refusals win over everything.** A 403 anywhere in the set means the operator's next
 *     action is a role binding, and saying "not installed" or "0" instead sends them to the wrong
 *     place. This holds even when other reads in the set succeeded — a partially-refused feature is
 *     `forbidden`, not `partial`, because the missing slice is missing for a fixable reason.
 *  2. **A confirmed absence is a real zero.** `absent === true` means a discovery probe got a 404
 *     from the API group itself, so the feature genuinely is not installed and its counts are true.
 *  3. **An unconfirmed absence is unknown**, never "not installed": `absent === null` is the state
 *     where the probe could not be made, and that is precisely where guessing is most tempting.
 *  4. Any other unavailable read makes the feature `partial` when something was read, `unknown`
 *     when nothing was.
 *  5. Truncation is `partial` — the rows are real but the set is a floor.
 *
 * @param {object} spec
 * @param {string} spec.feature
 * @param {Array<{label: string, unavailable: boolean, reason: string|null, detail: string|null,
 *                truncated: boolean, absent?: boolean|null, absentEvidence?: string|null}>} spec.reads
 * @param {boolean} [spec.gotAnything] whether the feature produced any usable rows; when false and
 *   some read failed, the state is `unknown` rather than `partial`
 * @param {string|null} [spec.notInstalledCause] the sentence clause for a confirmed absence
 */
/**
 * Whether a read failed because access was refused, rather than because the data was absent.
 *
 * Exported because callers that pre-process their read list — collapsing several probes of one
 * logical store into one, say — have to make the same distinction, and a second copy of the reason
 * set is a second thing to keep in step with `fromReads`.
 */
function isAccessRefusal(read) {
  return Boolean(read && read.unavailable && ACCESS_REASONS.has(read.reason));
}

function fromReads({ feature, reads, gotAnything = true, notInstalledCause = null }) {
  const list = Array.isArray(reads) ? reads.filter(Boolean) : [];

  const refused = list.find(isAccessRefusal);
  if (refused) {
    const others = list.filter(r => r !== refused && isAccessRefusal(r));
    return capability({
      feature,
      state: 'forbidden',
      cause: `${REASON_CLAUSE[refused.reason]} ${[refused, ...others].map(r => r.label).join(', ')}`,
      detail: refused.detail,
      missing: list.filter(r => r.unavailable).map(r => r.label)
    });
  }

  const absent = list.find(r => r.absent === true);
  if (absent) {
    return capability({
      feature,
      state: 'not-installed',
      cause: notInstalledCause || `the API group behind it is not registered on this cluster (${absent.label})`,
      detail: absent.absentEvidence || null
    });
  }

  const failed = list.filter(r => r.unavailable);
  if (failed.length > 0) {
    const first = failed[0];
    const clause = `${REASON_CLAUSE[first.reason] || 'the read did not succeed for'} ${failed
      .map(r => r.label)
      .join(', ')}`;
    // Nothing read at all is not a degraded view of the feature, it is no view of it.
    if (!gotAnything) return capability({ feature, state: 'unknown', cause: clause, detail: first.detail, missing: failed.map(r => r.label) });
    return capability({
      feature,
      state: 'partial',
      cause: `${clause}, so the rows below are a subset`,
      detail: first.detail,
      missing: failed.map(r => r.label)
    });
  }

  // `absent === null` on a read whose list came back as a swallowed 404: neither absence nor
  // presence was established, so the honest state is unknown even though nothing "failed".
  const unproven = list.find(r => r.absent === null && r.absentEvidence);
  if (unproven) {
    return capability({
      feature,
      state: 'unknown',
      cause: `this console could not establish whether the API behind it is installed (${unproven.label})`,
      detail: unproven.absentEvidence
    });
  }

  const short = list.filter(r => r.truncated);
  if (short.length > 0) {
    return capability({
      feature,
      state: 'partial',
      cause: `the read hit this console’s paging ceiling (${short.map(r => r.label).join(', ')}), so every count is a floor`,
      missing: []
    });
  }

  return available(feature);
}

/** A feature whose data source exists but is switched off — telemetry, a controller flag. */
function notConfigured(feature, cause, detail) {
  return capability({ feature, state: 'not-configured', cause, detail });
}

/** A feature whose numbers were real but are no longer being refreshed. */
function stale(feature, cause, extra) {
  return capability({ feature, state: 'stale', cause, extra });
}

/** A feature whose data lives somewhere the Kubernetes API cannot reach. */
function unsupportedBackend(feature, cause, extra) {
  return capability({ feature, state: 'unsupported-backend', cause, extra });
}

/** A feature this console could not classify. Never a substitute for one of the named states. */
function unknown(feature, cause, detail) {
  return capability({ feature, state: 'unknown', cause, detail });
}

/** The worst state in a set — what a parent screen should show for a group of features. */
function worst(capabilities) {
  const list = (Array.isArray(capabilities) ? capabilities : []).filter(c => c && c.state);
  if (list.length === 0) return null;
  return list.reduce((a, b) => (STATES[a.state].rank <= STATES[b.state].rank ? a : b));
}

export default {
  STATES,
  capability,
  available,
  fromReads,
  isAccessRefusal,
  notConfigured,
  stale,
  unsupportedBackend,
  unknown,
  worst
};
