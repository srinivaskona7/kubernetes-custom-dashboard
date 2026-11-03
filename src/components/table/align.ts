/**
 * Which way a column's values read — decided once, from the column's own label.
 *
 * The console's alignment rule used to live in two places: a paragraph in `DataTable.tsx` and a
 * source-scanning guard that checked tables against *each other*. That pair catches drift between
 * two existing tables and cannot do the thing that actually matters at this size — make the next
 * table right without anybody remembering the rule. Twenty-four `Column<T>[]` arrays and thirty-one
 * hand-written `<table className="tbl">` blocks is past the point where "remember to spread
 * `...NUMERIC`" is a mechanism.
 *
 * So the rule is a function of the header text. `DataTable` calls it for every column that does not
 * state an alignment of its own, which means a new column headed `Restarts` is right-aligned before
 * anybody reviews it, and `test/fleet/table-alignment.test.js` reads the same tokens out of this file
 * so a column that *contradicts* the classifier fails the suite rather than shipping.
 *
 * The three buckets are the operator's, not the compiler's:
 *
 *   left    an identity or a label — the eye scans the left edge down the column looking for a name
 *   right   a magnitude or a moment — digits only compare when their units line up
 *   center  a compact indicator whose values are all about the same width (a boolean, a small badge)
 *
 * Status deliberately stays **left**. It is the one bucket the request calls "where appropriate", and
 * on this console it is not appropriate: a status cell holds a pill whose text ranges from `Running`
 * to `CreateContainerConfigError`, and centring variable-width pills ragged both edges at once —
 * worse to scan than either alignment. Columns that really are fixed-width indicators opt in with
 * `CENTER`.
 */

export type Align = 'left' | 'right' | 'center';

/**
 * Header words that mean "this cell is a quantity".
 *
 * Matched against the header's words, not as substrings: `Restarts` matches, and `Restart policy`
 * does not, because a policy is a name. One-word entries carry the whole rule; multi-word entries
 * are matched as a phrase.
 */
export const NUMERIC_WORDS: readonly string[] = [
  // The request's own list.
  'cpu',
  'memory',
  'mem',
  // `request` alone is deliberately absent and `requests` is present. Traffic's `Request` column holds
  // a method and a path, which is an identity; `Requests` is a count, and a resource request reaches
  // this list through the phrases below. One ambiguous word aligned wrongly in one table is exactly
  // the drift this classifier exists to stop.
  'requests',
  'cpu request',
  'memory request',
  'limit',
  'limits',
  'usage',
  'used',
  'percent',
  'percentage',
  'share',
  'latency',
  // `error` alone is absent for the same reason: Tokens' `Last error` column holds a message.
  'errors',
  'error rate',
  'rate',
  'restart',
  'restarts',
  'count',
  'counts',
  'connection',
  'connections',
  'capacity',
  'headroom',
  // The same idea under the names this console actually uses on screen.
  'age',
  'allocatable',
  'available',
  'cores',
  'bytes',
  'size',
  'total',
  'replicas',
  'pods',
  'nodes',
  'containers',
  'namespaces',
  'violations',
  'denied',
  'allowed',
  'decisions',
  'requests/s',
  'rps',
  'p50',
  'p90',
  'p95',
  'p99',
  'quota',
  'desired',
  'ready',
  'expires',
  'expiry',
  'duration',
  'uptime',
  'revisions',
  'releases',
  'charts',
  'rules',
  'endpoints',
  'in use',
  'free',
  'min',
  'max',
  'avg',
  'sum'
];

/**
 * Header words that mean "this cell is a name", listed even though left is the default.
 *
 * Two reasons they are written down rather than left implicit: a word like `Endpoints` is a count and
 * `Endpoint` is a URL, and the guard needs to be able to say *why* a column is left rather than
 * assuming left for everything it does not recognise. An unrecognised header still defaults to left —
 * this list is the part the guard is willing to fail on.
 */
export const IDENTITY_WORDS: readonly string[] = [
  'pod',
  'node',
  'namespace',
  'workload',
  'service',
  'route',
  'endpoint',
  'resource',
  'container',
  'pool',
  'zone',
  'description',
  'path',
  'url',
  'host',
  'name',
  'cluster',
  'kind',
  'release',
  'chart',
  'policy',
  'webhook',
  'reason',
  'message',
  'owner',
  'source',
  'target',
  'backend',
  'type',
  'phase',
  'status',
  'class',
  'provider',
  'module',
  'secret',
  'issuer',
  'subject'
];

/** Normalise a header for matching: lower case, punctuation to spaces, collapse runs. */
function words(header: string): string[] {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9/%. ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The alignment a column with this header should have, or `null` when the classifier has no opinion.
 *
 * `null` is a real answer and not a failure: `Chart version` is neither a magnitude nor one of the
 * identity words, and a classifier that guessed at it would be inventing a rule the reviewer never
 * agreed to. A `null` column renders left (the default) and the guard leaves it alone.
 *
 * A header that mixes both buckets resolves to the **quantity**, because the quantity is the part the
 * cell renders: `Memory used`, `CPU requested`, `Pod restarts` are all numbers whose header happens
 * to name the subject they belong to.
 */
export function alignFor(header: string): Align | null {
  const w = words(header);
  if (!w.length) return null;
  const phrase = w.join(' ');
  const numeric = NUMERIC_WORDS.some(t => (t.includes(' ') ? phrase.includes(t) : w.includes(t)));
  if (numeric) return 'right';
  const identity = IDENTITY_WORDS.some(t => (t.includes(' ') ? phrase.includes(t) : w.includes(t)));
  if (identity) return 'left';
  // A header that is only a percent sign or a slashed ratio — `%`, `used / limit` — is a quantity.
  if (/^[%\d/.\s]+$/.test(phrase)) return 'right';
  return null;
}
