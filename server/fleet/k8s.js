/**
 * The Kubernetes client: one function that does an authenticated GET or POST against a
 * cluster API server, and turns every failure into a typed ClusterError.
 *
 * Deliberately not @kubernetes/client-node. That library wants a kubeconfig and owns its
 * own credential lifecycle; here the credential is a rotating string read from a Secret
 * mount, and the set of resources we read is small and fixed. A thin wrapper is less
 * code, has no dependencies, and — the part that matters — lets the 401/403 split reach
 * the UI intact instead of being flattened into a generic HttpError.
 *
 * Built on https.request rather than global fetch. Node's fetch is undici, which ignores
 * an `agent` option entirely (it takes a `dispatcher`), so a per-cluster CA bundle passed
 * that way is silently dropped and every in-cluster call fails TLS verification. Reaching
 * for https.request keeps the custom CA working without adding undici as a dependency.
 *
 * Three things sit on top of that round trip, all of them about behaving on a cluster
 * that is bigger or busier than a demo: LISTs follow the chunking cursor to completion
 * instead of returning a silently short array, throttled and transient reads are retried
 * (reads only — never a mutation), and no more than eight requests are in flight against
 * any one apiserver at a time.
 */
import fs from 'node:fs';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import errorsModule from './errors.js';
const { ClusterError, codeForStatus, UNREACHABLE, UPSTREAM } = errorsModule;

/**
 * The apiserver throttled us. Lives here rather than in errors.js because only the
 * transport can know a request was rate-limited — every layer above sees the retries
 * that already happened and failed. `needsReseed` is false for it, which is right:
 * the credential is fine, the server is busy.
 */
const RATE_LIMITED = 'RATE_LIMITED';

/**
 * Identify ourselves to the apiserver.
 *
 * This buys audit-log attribution and nothing else. Kubernetes API Priority and Fairness
 * classifies a request by its authenticated ServiceAccount, not by User-Agent, so nobody
 * should "optimise" this string expecting a different flow-schema or a higher share of
 * seats — it will not move throttling one bit.
 */
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || VERSION;
} catch { /* running from a trimmed image; an unknown version beats a crashing transport */ }
const USER_AGENT = `k8s-fleet-dashboard/${VERSION}`;

const DEFAULT_TIMEOUT_MS = 8000;

/** Total tries for an idempotent read: the first plus two retries. */
const MAX_ATTEMPTS = 3;
/** Base for exponential backoff when the server gives us no Retry-After to obey. */
const BACKOFF_BASE_MS = 250;
/**
 * A Retry-After longer than this is clamped. An apiserver under real pressure can ask for
 * a minute; a dashboard fanning out over a dozen clusters cannot spend a minute inside one
 * request, and the caller would rather see RATE_LIMITED and render a degraded tile.
 */
const RETRY_AFTER_CAP_MS = 5000;

/** Hard ceiling on a single paged LIST. Past this the result is marked truncated. */
const MAX_LIST_ITEMS = 20000;
/**
 * Backstop for a server that keeps handing back a continue token without making progress.
 * Note an empty page with a continue token is *legal* — a chunk whose every item was
 * filtered out by a label or field selector looks exactly like that — so "no items" can
 * never be the loop's exit condition. Counting pages can.
 */
const MAX_LIST_PAGES = 200;

/**
 * In-flight reads allowed per cluster.
 *
 * Chosen over the Agent's `maxSockets` because the Agent cache below is keyed by *CA
 * bundle*, not by cluster: every cluster that uses the system trust store, and every pair
 * that shares a caFile, shares one Agent and therefore one socket budget. `maxSockets`
 * cannot express "eight at a time against this apiserver". This gate can, and it is the
 * apiserver we are trying not to overrun. `maxSockets` is set to the same 8 so the pool
 * can never become a looser second limit that quietly re-admits the fan-out we just gated.
 */
const MAX_IN_FLIGHT_PER_CLUSTER = 8;

/**
 * Ask the apiserver for object *metadata* only — name, namespace, labels, annotations,
 * ownerRefs — and nothing else.
 *
 * The reason to reach for this is usually size, and the saving is not marginal: the
 * cluster-wide Secret list measured 1.2 MB gzipped as full objects and **38 KB** as metadata,
 * 4.3 s down to 1.6 s. For Secrets there is a second reason that matters more than speed —
 * the `data` block never enters this process at all, so a count cannot leak what it counted.
 *
 * The trade is strict and there is no way around it: every field outside `metadata` is gone.
 * A Secret read this way has no `.type`, a Pod has no `.status.phase`. Reading one of those
 * off a metadata-only item yields `undefined`, which is exactly the shape that turns into a
 * confident wrong answer ("every Secret is Opaque") rather than an error. Use it only where
 * the caller provably needs nothing but metadata, and get anything else with a field
 * selector — `?fieldSelector=type=kubernetes.io/tls` counts a type without fetching a body.
 */
const METADATA_ONLY = 'application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io';

/** Cache one Agent per CA. Rebuilding the TLS context per request is wasteful. */
const agents = new Map();
/** cluster id -> { active, waiting: [resolve] } */
const gates = new Map();

/* --------------------------------------------------------------- shared list reads */

/**
 * A read-through cache in front of `list`, because the expensive reads are the *shared*
 * ones.
 *
 * Measured against platformsbx before this existed: ten tab loads issued **80** separate
 * cluster-wide `/api/v1/pods` reads — 133 MB, 308 s of round trip and 207 s queued behind
 * the eight-slot gate. Eight collectors want the pod list and each one asked for its own
 * copy, concurrently, so they also starved every small read behind them. The route cache in
 * fanout.js could not help: it is keyed by route, and these are eight different routes all
 * needing the same underlying list.
 *
 * Two mechanisms, and the first is the one that matters:
 *
 *  - **Coalescing.** Identical reads already in flight share one promise. This is free —
 *    the callers are concurrent, so nobody sees data older than they would have anyway.
 *  - **A short TTL.** Deliberately a fraction of the route cache's 30 s rather than equal
 *    to it: a route computed at the end of its own TTL window must not be built from a list
 *    fetched at the start of a second full one. At 8 s the worst case a tab can show is
 *    38 s old, against 30 s before, and the reads it replaces cost longer than that
 *    difference to perform.
 *
 * Scoping, which is the part to get right rather than fast:
 *
 *  - The key includes a **fingerprint of the bearer token**, so a read made with one user's
 *    OIDC token is never served to another. Two users with different RBAC get different
 *    keys and therefore different reads, exactly as they did without a cache. The
 *    fingerprint is a truncated SHA-256 and never leaves the process.
 *  - `consistent: true` bypasses the cache in both directions — it neither reads an entry
 *    nor writes one. That flag exists for a read whose result is about to be acted on, and
 *    the whole point of it is to not get a copy.
 *  - Only `list` is cached. `call` and `text` are not: pod logs are a tail that must move,
 *    and a non-GET must never be replayed.
 *
 * Entries are never serialized, never logged, and are dropped for a cluster the moment it
 * is re-onboarded (see `forgetAgent`). They do hold raw objects — including Secrets, for
 * the Helm release reader — for the length of the TTL, which is the same exposure the
 * route cache above already has and strictly shorter.
 */
const LIST_CACHE_TTL_MS = Number(process.env.FLEET_LIST_CACHE_TTL_MS || 8000);
/**
 * Generous for one operator sweeping a fleet, and a hard ceiling rather than "whatever
 * memory allows" — the entries are whole API collections and a few are megabytes.
 */
const LIST_CACHE_MAX_ENTRIES = 240;
/** key -> { at, items, truncated } */
const listCache = new Map();
/** key -> Promise, so concurrent identical reads become one. */
const listInflight = new Map();

/**
 * Identify the credential without holding a second copy of it or ever being able to
 * reverse it. Truncated because this is a cache key, not an authenticator: a collision
 * would need two tokens sharing 64 bits of SHA-256, and both would have to be live against
 * the same cluster in the same eight seconds.
 */
function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

/**
 * `limit` is a *page size*, not a result bound: `list` follows the continue token to
 * completion either way, so `?limit=1500` and `?limit=2000` return the same set. Three
 * collectors picked three different values for the same pod list, which would otherwise be
 * three cache misses for one answer. Dropping it from the key — and only from the key; the
 * request still goes out as written — makes them one.
 *
 * Nothing else is normalised. A `fieldSelector` or `labelSelector` genuinely changes the
 * result and must stay in the key.
 */
function listCacheKey(cluster, token, path, method, accept) {
  const [base, query = ''] = String(path).split('?');
  const params = new URLSearchParams(query);
  params.delete('limit');
  params.sort();
  const rest = params.toString();
  // `accept` is part of the key, not decoration: a PartialObjectMetadataList read of
  // /api/v1/secrets and a normal one are the same URL and profoundly different payloads, and
  // serving the metadata-only copy to a caller that needs `.type` would silently report every
  // Secret as Opaque.
  return `${cluster.id} ${tokenFingerprint(token)} ${method} ${accept || '-'} ${base}${rest ? `?${rest}` : ''}`;
}

/**
 * Hand the caller their own array.
 *
 * Callers treat a list result as theirs — `logs.js` sorts it in place — and with a cache
 * behind it that sort would reorder the copy the next collector is about to read. A shallow
 * copy is cheap (it copies references, not objects) and fixes every array-level mutation.
 * `truncated` is re-attached non-enumerably, as `list` defines it.
 */
function cloneListResult(items, truncated) {
  const out = items.slice();
  if (truncated) Object.defineProperty(out, 'truncated', { value: true });
  return out;
}

function purgeExpiredLists(now) {
  for (const [key, hit] of listCache) {
    if (now - hit.at >= LIST_CACHE_TTL_MS) listCache.delete(key);
  }
}

/** Drop every cached read for one cluster. Called when its credential or CA changes. */
function forgetListCache(clusterId) {
  const prefix = `${clusterId} `;
  for (const key of [...listCache.keys()]) {
    if (key.startsWith(prefix)) listCache.delete(key);
  }
}

/**
 * A cluster's TLS context.
 *
 * Two sources of CA, because clusters arrive two ways. A cluster baked into the registry
 * names a file (`caFile`) — for the hub's own cluster that is the projected SA bundle. A
 * cluster onboarded by kubeconfig upload carries its CA inline (`caData`, PEM), because
 * there is no file to point at and writing one would mean a credential on disk.
 *
 * Neither is optional-by-accident: a cluster with neither uses the system trust store,
 * which is correct for a public Gardener endpoint and wrong for anything self-signed.
 * There is no skip-verify path, and a kubeconfig asking for one is rejected at parse time.
 */
function agentFor(cluster) {
  const caFile = cluster.caFile || null;
  const caData = cluster.caData || null;
  const key = caFile || (caData ? `data:${cluster.id}` : '__system__');
  if (agents.has(key)) return agents.get(key);

  // maxSockets matches MAX_IN_FLIGHT_PER_CLUSTER on purpose; see the comment there.
  const opts = { keepAlive: true, maxSockets: MAX_IN_FLIGHT_PER_CLUSTER };
  if (caData) {
    opts.ca = caData;
  } else if (caFile) {
    try {
      opts.ca = fs.readFileSync(caFile);
    } catch (err) {
      throw new ClusterError(UPSTREAM, `cannot read CA bundle ${caFile}: ${err.message}`);
    }
  }
  const agent = new https.Agent(opts);
  agents.set(key, agent);
  return agent;
}

/** Drop a cached TLS context, so re-onboarding a cluster with a new CA takes effect. */
function forgetAgent(clusterId) {
  agents.delete(`data:${clusterId}`);
  // Cached reads go with it. They were made with the old credential against the old CA, and
  // re-onboarding is exactly the moment an operator expects to see the new cluster's answer
  // rather than the previous one's for another eight seconds.
  forgetListCache(clusterId);
  // The gate goes too, but only once nothing is using it. A gate holding waiters must
  // survive: those are promises that only `release` ever resolves, so dropping the entry
  // they are queued on would hang every one of those requests for the life of the pod.
  // An in-flight `active` count must survive for the same reason — its `release` needs to
  // find this entry. Either way the next `acquire` recreates a clean gate, so the only
  // thing this reclaims is the idle leftover of a cluster nobody is reading any more.
  const gate = gates.get(clusterId);
  if (gate && gate.active === 0 && gate.waiting.length === 0 && gate.waitingLow.length === 0) {
    gates.delete(clusterId);
  }
}

/* ------------------------------------------------------------------ concurrency gate */

/**
 * Background sweeps must not make an operator wait.
 *
 * The sidebar polls `/summary` every 30 s, and that one request is a full seventeen-group
 * sweep of every cluster. Measured against platformsbx it held the gate for twenty seconds,
 * and a tab opened during it queued behind the whole thing: reads that take 250 ms on their
 * own were observed waiting 10 s for a slot. The tab was not slow — it was in line.
 *
 * So the sweep runs at low priority, which costs it two things and nothing else:
 *
 *  - a lower ceiling (`LOW_PRIORITY_MAX_IN_FLIGHT` of the gate's slots, not all of them), so
 *    there is always a slot free for a click even when a sweep is mid-flight;
 *  - last place in the queue, behind every interactive read waiting for the same cluster.
 *
 * Neither can starve it. The reserved slots are a floor for interactive work, not a cap on
 * background work, and a low-priority waiter still moves up as normal ones drain — under an
 * idle console, which is most of the time, a sweep gets the full gate.
 *
 * The level travels in `AsyncLocalStorage` rather than as a parameter because the
 * alternative is threading a flag through `runFanOut`, every collector and every `listFn`
 * call site — dozens of signatures, each one a chance to forget, for a value that is a
 * property of the *request* and not of any single read.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger } from '../logger.js';
const priorityScope = new AsyncLocalStorage();
const LOW_PRIORITY_MAX_IN_FLIGHT = Math.max(1, MAX_IN_FLIGHT_PER_CLUSTER - 2);

/** Run `fn` with every k8s read inside it marked as background work. */
function withLowPriority(fn) {
  return priorityScope.run({ low: true }, fn);
}

function isLowPriority() {
  const scope = priorityScope.getStore();
  return Boolean(scope && scope.low);
}

/** Take one of the cluster's slots, waiting in line when all of them are busy. */
function acquire(clusterId) {
  let gate = gates.get(clusterId);
  if (!gate) {
    gate = { active: 0, waiting: [], waitingLow: [] };
    gates.set(clusterId, gate);
  }
  const low = isLowPriority();
  const ceiling = low ? LOW_PRIORITY_MAX_IN_FLIGHT : MAX_IN_FLIGHT_PER_CLUSTER;
  if (gate.active < ceiling) {
    gate.active += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => (low ? gate.waitingLow : gate.waiting).push(resolve));
}

/** Hand the slot to whoever is next in line, or give it back to the pool. */
function release(clusterId) {
  const gate = gates.get(clusterId);
  if (!gate) return;
  // Interactive first, always. A low-priority waiter only takes the slot when no interactive
  // read wants it, and only while the sweep is under its own lower ceiling — otherwise the
  // handoff would re-admit the background work the ceiling just held back.
  const next = gate.waiting.shift()
    || (gate.active <= LOW_PRIORITY_MAX_IN_FLIGHT ? gate.waitingLow.shift() : undefined);
  if (next) next();          // slot changes hands; `active` is unchanged
  else gate.active -= 1;
}


/* ------------------------------------------------------------------------- retrying */

/**
 * Per-request timing, off unless `FLEET_TRACE_K8S=1`.
 *
 * Two numbers, not one: `wait` is time spent queued behind the concurrency gate and `ms` is
 * the round trip itself. A slow page is one or the other, and the fix is different for each —
 * a high `wait` means too many reads for the gate width, a high `ms` means the read itself is
 * expensive and wants a field selector or a narrower scope.
 */
const TRACE = process.env.FLEET_TRACE_K8S === '1';
function trace(clusterId, path, waitMs, ms, bytes) {
  getLogger().info(JSON.stringify({ k8s: clusterId, path, wait: waitMs, ms, bytes, t: Date.now() }));
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Retry-After comes in two shapes and the spec allows either: delta-seconds ("1") or an
 * HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT"). Returns null when the header is absent or
 * unparseable, which sends the caller to exponential backoff instead.
 */
function retryAfterMs(header) {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now();     // NaN when it is neither, handled below
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS);
}

/**
 * Exponential backoff with equal jitter. The jitter matters more than the exponent here:
 * a fan-out that throttles tends to throttle every cluster at once, and un-jittered
 * retries would all come back in the same millisecond and throttle again.
 */
function backoffMs(attempt) {
  const window = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.round(window / 2 + Math.random() * (window / 2));
}

/**
 * A socket that died mid-flight, as opposed to a request that ran out of *our* patience.
 * Our own deadline (`timeoutMs`) is deliberately excluded: it carries no `code`, and
 * retrying it would multiply the caller's stated time budget by three.
 */
function isTransientSocketError(err) {
  return err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
                 err.code === 'EPIPE' || err.code === 'EAI_AGAIN');
}

/** 429 and 503 are "come back later". Every other 4xx is a decision, not a delay. */
function isRetryableStatus(status) {
  return status === 429 || status === 503;
}

/**
 * Decompress a response body according to what the server said it did.
 *
 * Kubernetes compresses a response only when the client asks *and* the body is over about
 * 128 KB, so a small read comes back identity-encoded and skips this entirely. An unknown
 * encoding is an error rather than a guess — returning the raw deflate stream as "JSON"
 * would surface as an unparseable-body error a long way from its cause.
 */
function decodeBody(encoding, buffer, maxBytes, done) {
  const enc = String(encoding || 'identity').trim().toLowerCase();
  if (enc === 'identity' || enc === '') return done(null, buffer);
  // `maxOutputLength` stops the inflate *while it runs*, so a compression bomb is never
  // allocated at all — checking the size afterwards would be checking it too late. zlib
  // answers with ERR_BUFFER_TOO_LARGE, which is remapped so callers see one cause.
  const opts = { maxOutputLength: maxBytes };
  const guard = cb => (err, buf) =>
    err && err.code === 'ERR_BUFFER_TOO_LARGE'
      ? cb(tooLarge(`decompressed ${enc} body`, maxBytes))
      : cb(err, buf);
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzip(buffer, opts, guard(done));
  if (enc === 'deflate') return zlib.inflate(buffer, opts, guard(done));
  if (enc === 'br') return zlib.brotliDecompress(buffer, opts, guard(done));
  return done(new Error(`unsupported content-encoding "${enc}" from the apiserver`));
}

/**
 * The most bytes one apiserver response may occupy in this process, before AND after
 * decompression.
 *
 * Without it `request` buffered whatever the server chose to send and then handed the whole
 * thing to `JSON.parse`, which is the one place in the read path with no ceiling at all. The
 * pod is `limits.memory: 500M` at `replicaCount: 1`, the per-cluster gate allows 8 concurrent
 * reads, and a parsed object graph costs several times its own text — so a single unbounded
 * collection (the CRD list on this cluster is 12 MB of JSON) is enough to take the fleet API
 * down for every user, not just the one who asked.
 *
 * Both halves are checked, and the decompressed one is the half that matters: `Accept-Encoding:
 * gzip` means a 200 KB body on the wire can be gigabytes in memory, so a cap that only counts
 * what arrived on the socket is not a cap. `zlib`'s own `maxOutputLength` enforces the second
 * one while inflating rather than after, so the bomb never gets allocated.
 *
 * Sized above the largest real read (12 MB) with headroom, and overridable for an operator with
 * a bigger pod and a bigger cluster. It is a ceiling on a pathology, not a page size.
 */
const MAX_RESPONSE_BYTES = Math.max(1, Number(process.env.FLEET_MAX_RESPONSE_BYTES) || 24 * 1024 * 1024);

/** Carries the cause out of `request` so `call` can name it instead of saying UNREACHABLE. */
function tooLarge(what, limit) {
  return Object.assign(new Error(`${what} exceeds the ${limit} byte response cap`), { code: 'RESPONSE_TOO_LARGE' });
}

/**
 * One HTTPS round trip, promisified. Resolves with {status, statusText, headers, body} for
 * every response the server actually sent — including 4xx and 5xx. It rejects only when no
 * response was obtained at all, which is what separates UNREACHABLE from UPSTREAM.
 *
 * `body` is always a decoded string, so the compression negotiated here is invisible to
 * `call` and to every transport double in the tests.
 */
function request({ url, method, headers, payload, agent, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    // Destroying a socket makes the stream emit its own error a tick later, and that error —
    // ECONNRESET, ERR_STREAM_PREMATURE_CLOSE — would win the race and hide the real cause
    // *and* look retryable. The promise is settled once, here, by whoever gets there first.
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let target;
    try {
      target = new URL(url);
    } catch (err) {
      fail(new Error(`invalid API url ${url}: ${err.message}`));
      return;
    }
    if (target.protocol !== 'https:') {
      fail(new Error(`refusing to send a bearer token over ${target.protocol}//`));
      return;
    }

    const req = https.request(target, { method, headers, agent, timeout: timeoutMs }, res => {
      const chunks = [];
      let received = 0;
      res.on('data', c => {
        if (settled) return;
        received += c.length;
        if (received > maxBytes) {
          // Stop reading rather than finish and then complain: the point of the cap is to not
          // hold the bytes, and destroying closes the socket so the server stops sending too.
          chunks.length = 0;
          fail(tooLarge('response body', maxBytes));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        decodeBody(
          res.headers && res.headers['content-encoding'],
          Buffer.concat(chunks),
          maxBytes,
          (err, buf) => {
            if (err) { fail(err); return; }
            succeed({
              status: res.statusCode,
              statusText: res.statusMessage || '',
              headers: res.headers || {},
              body: buf.toString('utf8')
            });
          }
        );
      });
      res.on('error', fail);
    });

    req.on('timeout', () => {
      // `timeout` fires on socket inactivity; it does not abort on its own.
      req.destroy(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: 'TimeoutError' }));
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {object} args
 * @param {import('./registry').Cluster} args.cluster
 * @param {string} args.token       bearer token
 * @param {string} args.path        e.g. "/api/v1/nodes"
 * @param {'GET'|'POST'|'PATCH'|'PUT'} [args.method]
 * @param {object} [args.body]
 * @param {string} [args.contentType]
 * @param {number} [args.timeoutMs] per attempt, not per call
 * @param {'json'|'text'} [args.as]  response handling; logs are not JSON
 * @param {string} [args.accept]    override the Accept header; see METADATA_ONLY
 * @param {Function} [args.transport] test seam; defaults to the real https round trip
 * @param {Function} [args.sleep]     test seam; defaults to setTimeout
 * @returns {Promise<any>} the parsed JSON body, or the raw string when as === 'text'
 */
async function call({
  cluster, token, path, method = 'GET', body, contentType = 'application/json',
  timeoutMs = DEFAULT_TIMEOUT_MS, as = 'json', accept, transport = request, sleep = delay
}) {
  const url = `${cluster.apiUrl}${path}`;
  const payload = body === undefined ? null : JSON.stringify(body);
  // Only a read may be replayed. Re-sending a TokenRequest POST because the first one
  // *might* not have landed mints a second token nobody is holding.
  const idempotent = method === 'GET' || method === 'HEAD';

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: accept || (as === 'text' ? '*/*' : 'application/json'),
    // Kubernetes gzips a response body over ~128 KB when asked, and the collections this
    // dashboard reads are mostly well over it — a cluster-wide pod list measured 3.5 MB
    // plain and 487 KB gzipped, and came back a third faster for it (3.06 s -> 2.17 s,
    // four reps). Under 128 KB the server answers identity-encoded and nothing changes.
    // `request` decodes before resolving, so no caller sees a compressed body.
    'Accept-Encoding': 'gzip',
    'User-Agent': USER_AGENT,
    ...(payload ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) } : {})
  };

  const queuedAt = TRACE ? Date.now() : 0;
  await acquire(cluster.id);
  const sentAt = TRACE ? Date.now() : 0;
  try {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await transport({ url, method, agent: agentFor(cluster), timeoutMs, payload, headers });
        if (TRACE) trace(cluster.id, path, sentAt - queuedAt, Date.now() - sentAt, (res.body || '').length);
      } catch (err) {
        if (err instanceof ClusterError) throw err;
        // A body we refused to hold is a fact about the response, not about the socket. It must
        // never be retried — the second attempt buffers the same 24 MB and fails the same way,
        // three times the cost — and it must not read as UNREACHABLE, which would tell the
        // operator the cluster is down when it answered perfectly well.
        if (err && err.code === 'RESPONSE_TOO_LARGE') {
          throw new ClusterError(UPSTREAM, `${cluster.id}: ${path} ${err.message}`, {
            cluster: cluster.id, cause: err
          });
        }
        if (idempotent && attempt < MAX_ATTEMPTS && isTransientSocketError(err)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ClusterError(UNREACHABLE, `${cluster.id}: ${err.message}`, { cluster: cluster.id, cause: err });
      }

      const text = res.body;
      if (res.status < 200 || res.status >= 300) {
        if (idempotent && attempt < MAX_ATTEMPTS && isRetryableStatus(res.status)) {
          // The slot stays held across the sleep on purpose: a cluster that just said
          // "slow down" should not have the seven other in-flight reads for it released
          // onto the queue while we wait.
          const asked = retryAfterMs(res.headers && res.headers['retry-after']);
          await sleep(asked === null ? backoffMs(attempt) : asked);
          continue;
        }
        // The API server's own `message` is far more useful than the status line —
        // "serviceaccounts \"fleet-reader\" is forbidden: User ... cannot create resource"
        // names the exact missing rule.
        let message = `${res.status} ${res.statusText}`;
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.message) message = parsed.message;
        } catch { /* non-JSON error body; the status line is all we have */ }
        throw new ClusterError(
          res.status === 429 ? RATE_LIMITED : codeForStatus(res.status),
          message,
          { cluster: cluster.id, status: res.status }
        );
      }

      if (as === 'text') return text || '';
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new ClusterError(UPSTREAM, `${cluster.id}: API server returned non-JSON: ${err.message}`, {
          cluster: cluster.id, status: res.status
        });
      }
    }
  } finally {
    release(cluster.id);
  }
}

/** Append query parameters without touching whatever the caller already encoded. */
function withQuery(path, extra) {
  const pairs = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (!pairs.length) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

/**
 * GET a list resource and return every item, following the chunking cursor.
 *
 * Returns a plain Array — roughly forty call sites destructure, spread and `.map` the
 * result — with one addition: when the ceiling stops us early, a **non-enumerable**
 * `truncated: true` is defined on it. Non-enumerable so `JSON.stringify`, spread,
 * `Object.keys` and `deepStrictEqual` all behave exactly as they did before, and a caller
 * that wants the flag has to ask for it by name.
 *
 * `resourceVersion=0` asks the apiserver for the watch cache instead of a quorum read
 * against etcd, which is the cheapest latency win available to a read-only dashboard
 * fanning out across clusters. The price is that the answer may be a few hundred
 * milliseconds stale. That is correct for a screen someone is looking at and *wrong* for
 * a read-modify-write, so any caller that reads in order to then write must pass
 * `{ consistent: true }` and pay for the quorum read.
 *
 * Two consequences of `resourceVersion=0` worth knowing before deleting it:
 *  - the watch cache does not paginate, so the server may ignore a caller's `limit` and
 *    return the whole collection in one response. Complete, but not byte-bounded.
 *  - it is only sent on the first page. A continue token already pins the read to page
 *    one's resourceVersion and is always served from etcd, so repeating the hint on a
 *    continuation is at best meaningless.
 *
 * @param {object} args as `call`, plus:
 * @param {boolean} [args.consistent] force a quorum read
 */
async function list(args) {
  const { consistent = false, ...rest } = args;

  // A quorum read is asked for precisely because a copy will not do, so it neither reads
  // the cache nor fills it. A test that injects its own `transport` opts out too: a shared
  // cache across cases would make one test's fixture visible to the next.
  if (consistent || rest.transport || !rest.cluster || !rest.cluster.id) {
    return listUncached({ consistent, ...rest });
  }

  const key = listCacheKey(rest.cluster, rest.token, rest.path, rest.method || 'GET', rest.accept);
  const now = Date.now();
  purgeExpiredLists(now);

  const hit = listCache.get(key);
  if (hit) {
    if (TRACE) trace(rest.cluster.id, `HIT ${rest.path}`, 0, 0, 0);
    return cloneListResult(hit.items, hit.truncated);
  }

  const pending = listInflight.get(key);
  // Coalesced callers each get their own array for the same reason a cache hit does.
  if (pending) return pending.then(v => cloneListResult(v.items, v.truncated));

  const promise = (async () => {
    try {
      const items = await listUncached({ consistent, ...rest });
      const value = { items, truncated: Boolean(items.truncated) };
      listCache.set(key, { at: Date.now(), ...value });
      if (listCache.size > LIST_CACHE_MAX_ENTRIES) {
        // Map iteration is insertion order, so the front is the oldest. One insert can only
        // put it one over, so one eviction is always enough.
        listCache.delete(listCache.keys().next().value);
      }
      return value;
    } finally {
      listInflight.delete(key);
    }
  })();

  listInflight.set(key, promise);
  const value = await promise;
  return cloneListResult(value.items, value.truncated);
}

async function listUncached(args) {
  const { consistent = false, ...rest } = args;
  const out = [];
  let truncated = false;
  let cont = null;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const body = await call({
      ...rest,
      path: withQuery(rest.path, cont
        ? { continue: cont }
        : { resourceVersion: consistent ? null : '0' })
    });

    const items = (body && Array.isArray(body.items)) ? body.items : [];
    for (const item of items) {
      if (out.length >= MAX_LIST_ITEMS) { truncated = true; break; }
      out.push(item);
    }
    if (truncated) break;

    cont = (body && body.metadata && body.metadata.continue) || null;
    if (!cont) break;
    // Check the ceiling *before* asking for another page rather than after filling one,
    // so hitting it exactly costs no extra round trip.
    if (out.length >= MAX_LIST_ITEMS) { truncated = true; break; }
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }

  if (truncated) Object.defineProperty(out, 'truncated', { value: true });
  return out;
}

/** Convenience: GET a plain-text resource. Pod logs are the only one we read. */
function text(args) {
  return call({ ...args, as: 'text' });
}

/**
 * The namespace path segment for a namespaced list, or '' for a cluster-wide one.
 *
 * `namespace` arrives straight off `?namespace=` and is interpolated into a URL that carries
 * the fleet service account's bearer token, so it is untrusted input to an API path. Left
 * unencoded, a value like `../../../apis/rbac.authorization.k8s.io/v1/clusterroles?x=`
 * survives the `new URL()` in this module, which normalises the `..` segments away and
 * re-points the read at any list resource the account can reach on any registered cluster.
 * Encoding turns the separators into `%2F`, which the URL parser does not collapse.
 *
 * Encoding alone is not enough: `.` is unreserved, so `..` passes through untouched and
 * `new URL()` then folds `namespaces/../apirules` down to the cluster-wide `/apirules`. A
 * dot-only segment is not a legal namespace name, so it is refused rather than encoded.
 * Both halves are load-bearing. One implementation, shared by every collector that builds a
 * namespaced path, so this guard cannot drift between copies again.
 */
function namespaceSegment(namespace) {
  if (!namespace) return '';
  const name = String(namespace);
  if (/^\.+$/.test(name)) {
    const err = new Error('invalid namespace: a namespace name cannot be made only of dots');
    err.status = 400;
    throw err;
  }
  return `namespaces/${encodeURIComponent(name)}/`;
}

/**
 * Most namespaces one request may select at once.
 *
 * Deliberately `MAX_IN_FLIGHT_PER_CLUSTER`: a namespace-scoped collector makes a handful of
 * reads per namespace, so at this width the fan-out is a few waves through the gate above.
 * Past it the fan-out stops being the cheaper answer than reading the cluster once and
 * filtering — see the note on `collect()` in collectors/workloads.js, which is where that
 * trade-off is actually made. A cap also means a URL cannot ask for a thousand reads.
 */
const MAX_NAMESPACE_SELECTION = MAX_IN_FLIGHT_PER_CLUSTER;

/**
 * The only thing Kubernetes will ever accept as a namespace name: a DNS-1123 label.
 * Lowercase alphanumerics and `-`, alphanumeric at both ends, at most 63 characters.
 */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * A `?namespace=` parameter that may name several namespaces into a validated, ordered set.
 *
 * Two wire forms are accepted because both already arrive here. Repeated keys
 * (`?namespace=a&namespace=b`) is the canonical one — Express hands a repeated key over as an
 * array without a bespoke split, and it is the form the console emits. A comma-separated value
 * (`?namespace=a,b`) is honoured as the same question, and honouring it fixes a latent bug
 * rather than adding a second syntax: before this existed an array reached `namespaceSegment`
 * and `String(['a','b'])` encoded `a,b` whole into ONE path segment, producing a 404 the UI
 * renders as an auth failure. A comma cannot occur in a DNS-1123 label, so neither form is
 * ambiguous.
 *
 * Validation is not politeness. `namespaceSegment` percent-encodes and refuses a dots-only
 * name, which is what stops the `..` traversal documented above it — but it will faithfully
 * encode any other rubbish, so an unvalidated value is still spent as a cluster round trip
 * that comes back 404 (rendered as an availability failure), and a value carrying `?` or `&`
 * would ride into the query string of a request this module wrote. Refusing anything that is
 * not a namespace name closes both without relying on the encoder.
 *
 * Deduped and sorted, because the caller's cache key is a property of the SET and not of the
 * order a browser happened to serialise it in: `?namespace=b&namespace=a` and
 * `?namespace=a&namespace=b` are one question, and two cache entries for it would double the
 * reads and let the two views disagree by up to a TTL.
 *
 * @param {string|string[]|undefined} value raw `req.query.namespace`
 * @returns {string[]} sorted and deduped; empty means cluster-wide
 * @throws {Error & {status: 400}} on a name that is not a DNS-1123 label, or too many of them
 */
function normaliseNamespaces(value) {
  const raw = (Array.isArray(value) ? value : [value])
    .flatMap(v => (v === undefined || v === null ? [] : String(v).split(',')))
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  for (const name of raw) {
    if (!DNS_1123_LABEL.test(name)) {
      const err = new Error(`invalid namespace "${name}": a namespace name is a DNS-1123 label ` +
        '(lowercase letters, digits and "-", alphanumeric at both ends, at most 63 characters)');
      err.status = 400;
      throw err;
    }
    seen.add(name);
    // Inside the loop, so a URL naming a thousand namespaces is refused at nine rather than
    // validated in full first.
    if (seen.size > MAX_NAMESPACE_SELECTION) {
      const err = new Error(`too many namespaces: at most ${MAX_NAMESPACE_SELECTION} may be selected at once`);
      err.status = 400;
      throw err;
    }
  }
  return [...seen].sort();
}

export default {
  call, list, text, forgetAgent, forgetListCache, namespaceSegment, normaliseNamespaces, tokenFingerprint,
  withLowPriority,
  DEFAULT_TIMEOUT_MS, RATE_LIMITED, USER_AGENT, METADATA_ONLY,
  MAX_LIST_ITEMS, MAX_IN_FLIGHT_PER_CLUSTER, LOW_PRIORITY_MAX_IN_FLIGHT, LIST_CACHE_TTL_MS,
  MAX_NAMESPACE_SELECTION
};
