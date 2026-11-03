/**
 * One shared list-with-degradation helper for every collector.
 *
 * A collector reads a dozen resource types per cluster, and some of them are optional:
 * Istio, Cert-Manager and the Kyma APIRule CRDs are simply absent on a plain cluster.
 * So a failed list cannot abort the collection — but it also must not be flattened into
 * an empty array, which is what the three private copies of this function used to do:
 *
 *     try { return await listFn({ ...ctx, path }); } catch { return []; }
 *
 * Under that catch a 403, an 8-second timeout and a genuinely empty cluster all reach the
 * operator as the number 0. Zero is the worst available answer, because it is
 * indistinguishable from good news — "no expiring certificates" reads as healthy whether
 * it means the fleet is clean or the token lost its RBAC an hour ago.
 *
 * The split this module draws is therefore between exactly two kinds of failure:
 *
 *   404 / Status reason NotFound / no such CRD -> a TRUE ZERO. The API group is not
 *       registered, the feature is not installed, and 0 is the honest answer.
 *   everything else                            -> UNAVAILABLE, with a reason code the UI
 *       can render as "could not read" rather than as a count.
 *
 * Getting the 404-vs-403 detection right is the whole point of the module, and it is
 * fiddly because the same condition arrives in four shapes: a typed ClusterError carrying
 * `status`, a Kubernetes `Status` object body, a client library's `statusCode`, and a bare
 * `throw new Error('boom')` with nothing structured on it at all.
 *
 * There is a third kind of nothing, and it is not a failure at all: a read that SUCCEEDED
 * but came back short because `k8s.list` hit its own paging ceiling. That is reported
 * separately, and the note on `isTruncated` says why it must never be folded into
 * `unavailable`.
 */

/** Reason codes. Deliberately not the ClusterError vocabulary — see the note on AUTH_CODES. */
const FORBIDDEN = 'FORBIDDEN';
const UNAUTHORIZED = 'UNAUTHORIZED';
const RATE_LIMITED = 'RATE_LIMITED';
const TIMEOUT = 'TIMEOUT';
const UPSTREAM = 'UPSTREAM';

/** Longest `detail` we hand to the UI. Fits a full RBAC denial, which names the missing rule. */
const MAX_DETAIL = 240;

/**
 * ClusterError codes (server/fleet/errors.js) that mean "the credential itself is the problem".
 * Note the vocabulary mismatch: that module calls a 401 UNAUTHENTICATED, which is the more
 * correct word, while this module's contract with the collectors and the UI says
 * UNAUTHORIZED. Both are accepted on the way in; only UNAUTHORIZED goes out.
 */
const AUTH_CODES = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED', 'EXPIRED', 'UNSEEDED']);

/** errno / library codes that mean the request ran out of time rather than being refused. */
const TIMEOUT_ERRNOS = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

/**
 * Messages the API server and kubectl use for an unregistered API group. These carry a 404
 * in production, so they only matter when an error arrives with no structured status at all
 * — a discovery helper or a test double re-throwing the text.
 */
const NO_CRD_HINTS = [
  'could not find the requested resource',
  "doesn't have a resource type",
  'does not have a resource type',
  'no matches for kind',
  'unknown resource type',
  'the server could not find'
];

/** Walk `err.cause` — k8s.js wraps a socket TimeoutError inside a ClusterError. */
function chain(err) {
  const out = [];
  const seen = new Set();
  let node = err;
  while (node && typeof node === 'object' && !seen.has(node) && out.length < 8) {
    seen.add(node);
    out.push(node);
    node = node.cause;
  }
  return out;
}

/** Parse a Status body that may already be an object or may still be JSON text. */
function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The Kubernetes `Status` object, wherever the thrower parked it: on `body` (the shape
 * @kubernetes/client-node uses), on `response.body` / `response.data` (http clients), or
 * as the thrown value itself.
 */
function statusObject(err) {
  for (const node of chain(err)) {
    const candidates = [
      node,
      node.body,
      node.data,
      node.response && node.response.body,
      node.response && node.response.data
    ];
    for (const candidate of candidates) {
      const obj = asObject(candidate);
      if (obj && obj.kind === 'Status') return obj;
    }
  }
  return null;
}

/** The HTTP status, from any of the places a thrower might have put a number. */
function httpStatus(err) {
  const status = statusObject(err);
  if (status && Number.isFinite(status.code)) return status.code;

  for (const node of chain(err)) {
    const candidates = [
      node.status,
      node.statusCode,
      node.response && node.response.status,
      node.response && node.response.statusCode,
      // Some clients overload `code` with the numeric status; a string `code` is a
      // ClusterError code or an errno and must not be read as one.
      typeof node.code === 'number' ? node.code : undefined
    ];
    for (const candidate of candidates) {
      if (Number.isFinite(candidate) && candidate >= 100 && candidate <= 599) return candidate;
    }
  }
  return null;
}

/** The `reason` field of a Status body, e.g. "NotFound", "Forbidden", "TooManyRequests". */
function statusReason(err) {
  const status = statusObject(err);
  return status && typeof status.reason === 'string' ? status.reason : null;
}

/** True when the failure is "the clock ran out", not "the server said no". */
function looksLikeTimeout(err) {
  for (const node of chain(err)) {
    if (node.name === 'TimeoutError' || node.name === 'AbortError') return true;
    if (typeof node.code === 'string' && TIMEOUT_ERRNOS.has(node.code)) return true;
    if (typeof node.message === 'string' && /\b(timed?[ -]?out|timeout)\b/i.test(node.message)) return true;
  }
  return false;
}

/** True when the message says the API group simply is not registered on this cluster. */
function looksLikeMissingCrd(err) {
  for (const node of chain(err)) {
    const message = typeof node.message === 'string' ? node.message.toLowerCase() : '';
    if (message && NO_CRD_HINTS.some(hint => message.includes(hint))) return true;
  }
  return false;
}

/** The first ClusterError-style string code in the chain, if there is one. */
function typedCode(err) {
  for (const node of chain(err)) {
    if (typeof node.code === 'string' && node.code === node.code.toUpperCase()) return node.code;
  }
  return null;
}

/**
 * Strip anything that must not reach an operator's screen or a log line: bearer headers,
 * JWTs, URL userinfo, key/secret assignments — and the stack, by keeping the first line only.
 */
function redact(raw) {
  let text = String(raw == null ? '' : raw).split('\n')[0].trim();
  if (!text) return null;

  text = text
    // JWTs first, so a "Bearer eyJ..." loses the token before the header rule generalises it.
    .replace(/eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+){1,3}/g, '[redacted]')
    .replace(/\b(bearer)\s+\S+/gi, '$1 [redacted]')
    // https://user:password@host -> https://[redacted]@host
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1[redacted]@')
    .replace(
      /\b((?:access[_-]|id[_-]|refresh[_-])?token|api[_-]?key|secret|password|passwd|pwd|authorization)(["']?\s*[:=]\s*["']?)[^\s,;"'&})\]]+/gi,
      '$1$2[redacted]'
    );

  if (text.length > MAX_DETAIL) text = `${text.slice(0, MAX_DETAIL - 1)}…`;
  return text;
}

/** The operator-facing message for a failure, already redacted. */
function detailOf(err) {
  const status = statusObject(err);
  // The API server's own `message` names the exact missing RBAC rule; prefer it.
  const raw =
    (status && typeof status.message === 'string' && status.message) ||
    (err && typeof err.message === 'string' && err.message) ||
    (typeof err === 'string' ? err : '') ||
    'list failed';
  return redact(raw) || 'list failed';
}

/** A true zero: the resource type is not installed, so 0 is the honest count. */
function trueZero(label) {
  return { label, items: [], unavailable: false, reason: null, detail: null, truncated: false };
}

/**
 * Did this list come back short because the client's paging ceiling was reached?
 *
 * `k8s.list` stops at MAX_LIST_ITEMS / MAX_LIST_PAGES and marks the array it returns with a
 * **non-enumerable** `truncated: true` — non-enumerable so that `JSON.stringify`, spread and
 * `Object.keys` are unaffected, which in turn means the flag can only be read by asking for
 * it by name. Nothing did, so past the ceiling the array was simply short and every count
 * derived from it was quietly wrong: the same silent lie as a caught 403, arriving by a
 * different road.
 *
 * Truncation is emphatically NOT unavailability, and the two must not share a channel:
 *
 *   unavailable  the read did not happen. The count is not a number, it is an em-dash.
 *   truncated    the read happened and the items are real. The count is a FLOOR, not a
 *                total — "at least 20000 pods", never "20000 pods" and never a dash.
 *
 * Folding a truncated read into `unavailable` would replace a true lower bound with
 * "unavailable", which tells the operator less than the truth we actually hold. So it rides
 * beside that array, in the same vocabulary of labels — see `truncatedLabels`.
 *
 * Exported because a read that is deliberately left outside `safeList` to fail loudly
 * (`security.js`'s pod audit, `topology.js`'s node list) still needs the flag read off its
 * raw array, and this is the one place that knows how `k8s.js` marks it.
 *
 * @param {any} items the array `k8s.list` resolved to
 * @returns {boolean}
 */
function isTruncated(items) {
  return Array.isArray(items) && items.truncated === true;
}

/**
 * Decide which of the five reason codes a failure is, or null for a true zero.
 *
 * Order matters. A numeric status beats a string code, because k8s.js maps every
 * non-401/403 status — 404 included — onto the single ClusterError code UPSTREAM while
 * preserving the real number in `status`. Reading the code first would report every
 * missing CRD in the fleet as an upstream fault.
 */
function classify(err) {
  const status = httpStatus(err);
  const reason = statusReason(err);

  if (status === 404 || reason === 'NotFound') return null;

  if (status === 403) return FORBIDDEN;
  if (status === 401) return UNAUTHORIZED;
  if (status === 429) return RATE_LIMITED;
  if (status === 408) return TIMEOUT;
  // Everything else the server actually answered with — 5xx included, per the contract —
  // is an upstream fault, even a 504 whose name says timeout.
  if (Number.isFinite(status)) return UPSTREAM;

  if (reason === 'Forbidden') return FORBIDDEN;
  if (reason === 'Unauthorized') return UNAUTHORIZED;
  if (reason === 'TooManyRequests') return RATE_LIMITED;

  const code = typedCode(err);
  if (code === 'FORBIDDEN') return FORBIDDEN;
  if (code && AUTH_CODES.has(code)) return UNAUTHORIZED;
  if (code === 'RATE_LIMITED' || code === 'TOO_MANY_REQUESTS') return RATE_LIMITED;
  if (code === 'TIMEOUT') return TIMEOUT;

  // No status, no reason, no typed code: fall back to reading the message. A bare
  // `throw new Error('boom')` lands past all of these as UPSTREAM, which is correct —
  // we do not know what happened, and we must not claim the cluster is clean.
  if (looksLikeMissingCrd(err)) return null;
  if (looksLikeTimeout(err)) return TIMEOUT;
  return UPSTREAM;
}

/**
 * List a resource, degrading instead of throwing, and say which kind of nothing came back.
 *
 * @param {(args: object) => Promise<any[]>} listFn   usually k8s.list, or a test double
 * @param {object} ctx    spread into the call; must carry at least {cluster, token}
 * @param {string} path   API path, e.g. "/apis/cert-manager.io/v1/certificates"
 * @param {string} [label] operator-facing name for this read; defaults to the path
 * @returns {Promise<{label: string, items: any[], unavailable: boolean, reason: string|null,
 *                    detail: string|null, truncated: boolean}>}
 */
async function safeList(listFn, ctx, path, label) {
  const name = label || path;
  try {
    const items = await listFn({ ...ctx, path });
    // k8s.list always resolves to an array; a double may not. An absent list is a zero,
    // not an outage — but never hand a non-array on to a caller that will .map() it.
    // The array is passed through by reference and never copied: k8s.js's non-enumerable
    // `truncated` flag would not survive a spread, a slice or a map.
    return {
      label: name,
      items: Array.isArray(items) ? items : [],
      unavailable: false,
      reason: null,
      detail: null,
      truncated: isTruncated(items)
    };
  } catch (err) {
    const reason = classify(err);
    if (reason === null) return trueZero(name);
    // A failed read has no items, so there is nothing for a ceiling to have cut short.
    return { label: name, items: [], unavailable: true, reason, detail: detailOf(err), truncated: false };
  }
}

/**
 * The labels of every read that could not be performed. An empty array means every read
 * either succeeded or returned an honest zero — the only case where a count can be trusted.
 *
 * @param {Array<{label: string, unavailable: boolean}>} results
 * @returns {string[]}
 */
function unavailableLabels(results) {
  if (!Array.isArray(results)) return [];
  return results
    .filter(r => r && r.unavailable === true)
    .map(r => r.label)
    .filter(label => typeof label === 'string' && label.length > 0);
}

/**
 * The labels of every read that succeeded but came back short at the paging ceiling.
 *
 * Same element type and same label vocabulary as `unavailableLabels`, deliberately as a
 * SEPARATE list rather than as extra entries in that one. The `unavailable: string[]`
 * contract means "these could not be read" to five collectors, to `/report` and to the
 * whole UI; a truncated read was read, so adding it there would turn a real lower bound
 * into an em-dash and change the meaning of the field under every existing consumer.
 * Beside it, `truncated: string[]` is purely additive: code that never looks at the new key
 * behaves exactly as before.
 *
 * A read that is both truncated and unavailable cannot happen — see `safeList`.
 *
 * @param {Array<{label: string, truncated?: boolean}>} results
 * @returns {string[]}
 */
function truncatedLabels(results) {
  if (!Array.isArray(results)) return [];
  return results
    .filter(r => r && r.truncated === true)
    .map(r => r.label)
    .filter(label => typeof label === 'string' && label.length > 0);
}

/**
 * Like `safeList`, but for a resource that is expected to always exist — nodes, or a CRD a
 * caller has independently confirmed via discovery. A 404 on one of these is not "the feature
 * is absent", it is a red flag (a wrong path, a cluster that has lost a core API), so it must
 * not be reported as a trusted zero the way an optional CRD's 404 is.
 *
 * @param {string} label operator-facing name for this read
 * @param {() => Promise<any[]>} fn the read to perform; already bound to its ctx/path
 * @returns {Promise<{label: string, items: any[], unavailable: boolean, reason: string|null,
 *                    detail: string|null, truncated: boolean}>}
 */
async function requiredList(label, fn) {
  try {
    const items = await fn();
    return {
      label,
      items: Array.isArray(items) ? items : [],
      unavailable: false,
      reason: null,
      detail: null,
      truncated: isTruncated(items)
    };
  } catch (err) {
    const reason = classify(err);
    if (reason === null) {
      // A 404 on a resource we expect to always exist is not an honest zero — it is
      // "the apiserver told us no" for something that should never say no.
      return {
        label,
        items: [],
        unavailable: true,
        reason: 'UPSTREAM',
        detail: `expected to exist but returned 404: ${detailOf(err)}`,
        truncated: false
      };
    }
    return { label, items: [], unavailable: true, reason, detail: detailOf(err), truncated: false };
  }
}

/**
 * Like `safeList`, but additionally probes GET /apis/<group>/<version> to distinguish "the
 * CRD is not installed" (404 on both the list and the group) from "the CRD is installed but
 * this particular list call failed for some other reason" (list fails, group probe succeeds
 * or fails differently).
 *
 * @param {(args: object) => Promise<any[]>} listFn
 * @param {object} ctx
 * @param {string} path
 * @param {string} label
 * @param {object} opts
 * @param {string} opts.group    API group, e.g. "cert-manager.io"
 * @param {string} opts.version  API version, e.g. "v1"
 * @param {(args: object) => Promise<any>} opts.callFn  transport for the discovery GET;
 *   when absent the probe cannot be made and `absent` comes back null, never guessed.
 * @returns {Promise<{label: string, items: any[], unavailable: boolean, reason: string|null,
 *                    detail: string|null, truncated: boolean, absent: boolean|null,
 *                    absentEvidence: string|null}>}
 */
async function absentList(listFn, ctx, path, label, { group, version, callFn } = {}) {
  // Track whether the underlying call actually threw a swallowed 404, as opposed to
  // resolving to a genuinely empty array — safeList's result alone cannot tell the two
  // apart (both come back {unavailable:false, items:[]}), and only the swallowed case
  // is ambiguous enough to be worth the extra request.
  let swallowed = false;
  const result = await safeList(
    async args => {
      try {
        return await listFn(args);
      } catch (err) {
        swallowed = true;
        throw err;
      }
    },
    ctx,
    path,
    label
  );

  // A real failure, a real success with items, or a genuinely empty success: none of these
  // need the probe. The last one in particular must not trigger it — that is the "happy
  // path costs nothing extra" guarantee this function exists to keep.
  if (result.unavailable || result.items.length > 0 || !swallowed) {
    return { ...result, absent: false, absentEvidence: null };
  }
  // A swallowed 404 came back as a trueZero(): could be a true 404-derived zero, or the
  // CRD genuinely serving an empty list while *also* 404ing — which cannot happen — so in
  // practice this branch is reached only by the swallowed-404 case. Only the group probe
  // can confirm whether the CRD itself is absent.
  if (typeof callFn !== 'function' || !group || !version) {
    return { ...result, absent: null, absentEvidence: null };
  }

  let groupBody = null;
  let probeThrew = false;
  const probe = await safeList(
    async args => {
      try {
        groupBody = await callFn(args);
        return [];
      } catch (err) {
        probeThrew = true;
        throw err;
      }
    },
    ctx,
    `/apis/${group}`,
    `${label}:group-discovery`
  );

  if (probeThrew && !probe.unavailable) {
    // The group discovery endpoint itself 404'd: the CRD's API group is not registered.
    return { ...result, absent: true, absentEvidence: `/apis/${group} returned 404` };
  }
  if (probe.unavailable) {
    // We now know neither that the CRD is absent nor that it is present. `absentProbeReason`
    // carries the probe's own reason code (FORBIDDEN, RATE_LIMITED, ...) so a caller that
    // wants to surface *why* the probe failed — not just that it did — does not have to
    // re-derive it from the sentence in `absentEvidence`.
    return {
      ...result,
      absent: null,
      absentEvidence: `could not probe /apis/${group}: ${probe.detail}`,
      absentProbeReason: probe.reason
    };
  }

  const versions = (groupBody && Array.isArray(groupBody.versions) ? groupBody.versions : [])
    .map(v => (v && typeof v.version === 'string' ? v.version : null))
    .filter(Boolean);
  if (versions.includes(version)) {
    // This branch is reached only after a swallowed 404 on the list itself (see the
    // `swallowed` guard above), so this is not "no error at all" — it is a contradiction:
    // discovery says the version is served, yet the list under it 404'd. A module mid-install,
    // or a path that is wrong in a way discovery cannot see. Certainly not a verified zero.
    return {
      ...result,
      absent: null,
      absentEvidence: `${group} reports ${version} as served but the list under it returned 404`,
      absentContradiction: true
    };
  }
  return {
    ...result,
    absent: null,
    absentEvidence: versions.length > 0
      ? `${group} serves ${versions.join(', ')}, not ${version}`
      : `${group} is registered but reports no served versions`
  };
}

export default { safeList, requiredList, absentList, unavailableLabels, truncatedLabels, isTruncated };
