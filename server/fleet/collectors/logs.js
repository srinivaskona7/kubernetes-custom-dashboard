/**
 * Pod logs.
 *
 * Separated from the workloads collector on purpose. Everything else the dashboard reads
 * is cluster *metadata* — counts, phases, versions. Logs are application data: they are
 * the one thing here that can contain a customer's name or a bearer token someone printed
 * by mistake. Keeping them in their own module, behind their own RBAC rule (pods/log) and
 * their own route, means the decision to expose them can be reversed in one place.
 *
 * Never cached. A log tail that is thirty seconds stale is worse than useless during an
 * incident — it reads as "nothing new is happening" when something is.
 */
import k8sModule from '../k8s.js';
const { list, text } = k8sModule;

/** Hard ceiling regardless of what the caller asks for. */
const MAX_TAIL_LINES = 2000;
const DEFAULT_TAIL_LINES = 200;
/**
 * The byte ceiling on one tail, and the second way a window can be cut.
 *
 * Without it the API server will happily stream a gigabyte from a chatty pod. With it there are two
 * independent bounds — lines and bytes — and only one of them used to be reported: `truncated` was
 * `parsed.length >= lines`, so a container whose last 200 lines are 3 MB of stack traces came back
 * `truncated: false` under a 2 MB cut. "Complete" is the one thing this response must never claim
 * when it is not, so byte truncation is its own flag rather than folded into the line one.
 */
const LOG_LIMIT_BYTES = 2_000_000;
/**
 * The stamp the API server prefixes when `timestamps=true`. Used to recognise a line the byte cut
 * landed in the middle of: every complete line starts with one, so a first line that does not, in a
 * response that hit the byte ceiling, is a fragment of a line rather than a line.
 */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z/;
/** Logs can be slow to stream out of a busy pod; give them longer than a metadata GET. */
const LOG_TIMEOUT_MS = 20_000;

/**
 * The pods a log viewer needs to offer, with their containers.
 *
 * Returned separately from the log text so the UI can populate its pickers without
 * fetching a single byte of log.
 *
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list}} ctx
 */
async function inventory({ cluster, token, namespace, listFn = list }) {
  const scope = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  const pods = await listFn({ cluster, token, path: `/api/v1${scope}/pods?limit=2000` });

  const items = pods.map(p => {
    const spec = p.spec || {};
    const status = p.status || {};
    const statuses = status.containerStatuses || [];
    const byName = new Map(statuses.map(cs => [cs.name, cs]));

    const containers = [...(spec.containers || []), ...(spec.initContainers || [])].map(c => {
      const cs = byName.get(c.name);
      const init = (spec.initContainers || []).some(i => i.name === c.name);
      return {
        name: c.name,
        image: c.image,
        init,
        ready: cs ? Boolean(cs.ready) : false,
        restarts: cs ? (cs.restartCount || 0) : 0,
        // `previous` only works when there IS a previous instance. Offering the toggle
        // when there is nothing to show produces a confusing empty pane.
        hasPrevious: Boolean(cs && cs.lastState && (cs.lastState.terminated || cs.lastState.running)),
        state: cs ? Object.keys(cs.state || {})[0] || 'unknown' : 'unknown',
        reason: cs && cs.state && cs.state.waiting ? cs.state.waiting.reason : null
      };
    });

    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      cluster: cluster.id,
      node: spec.nodeName || null,
      phase: status.phase || 'Unknown',
      restarts: statuses.reduce((n, cs) => n + (cs.restartCount || 0), 0),
      startedAt: status.startTime || null,
      containers
    };
  });

  // Pods that are unhappy first: during an incident they are the ones being looked for.
  const rank = p => (p.phase === 'Running' && p.restarts === 0 ? 2 : p.phase === 'Running' ? 1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || (a.namespace + a.name).localeCompare(b.namespace + b.name));

  return {
    summary: {
      pods: items.length,
      namespaces: new Set(items.map(p => p.namespace)).size,
      containers: items.reduce((n, p) => n + p.containers.length, 0)
    },
    items
  };
}

/**
 * Fetch one container's log tail.
 *
 * @param {object} ctx
 * @param {object} ctx.cluster
 * @param {string} ctx.token
 * @param {string} ctx.namespace
 * @param {string} ctx.pod
 * @param {string} [ctx.container]
 * @param {number} [ctx.tailLines]
 * @param {boolean} [ctx.previous]  the instance before the last restart
 * @param {number} [ctx.sinceSeconds]
 * @param {boolean} [ctx.timestamps]
 * @param {typeof text} [ctx.textFn]
 */
async function tail({
  cluster, token, namespace, pod, container,
  tailLines = DEFAULT_TAIL_LINES, previous = false, sinceSeconds, timestamps = true,
  textFn = text
}) {
  if (!namespace || !pod) throw Object.assign(new Error('namespace and pod are required'), { status: 400 });

  const lines = Math.min(Math.max(Number(tailLines) || DEFAULT_TAIL_LINES, 1), MAX_TAIL_LINES);
  const params = new URLSearchParams({ tailLines: String(lines), timestamps: String(Boolean(timestamps)) });
  if (container) params.set('container', container);
  if (previous) params.set('previous', 'true');
  if (sinceSeconds) params.set('sinceSeconds', String(Math.max(1, Number(sinceSeconds))));
  // Without this the API server will happily stream a gigabyte from a chatty pod.
  params.set('limitBytes', String(LOG_LIMIT_BYTES));

  const body = await textFn({
    cluster, token,
    path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${params}`,
    timeoutMs: LOG_TIMEOUT_MS
  });

  const raw = String(body || '');
  const bytesRead = Buffer.byteLength(raw, 'utf8');
  /*
    The byte ceiling was reached, so lines exist that this read never saw — a different fact from
    the line budget being full, and reported separately. `>=` rather than `===` because the cut is
    applied to a byte stream and the decoded string can land exactly on it.
  */
  const bytesTruncated = bytesRead >= LOG_LIMIT_BYTES;

  const split = raw.length ? raw.replace(/\n$/, '').split('\n') : [];
  // Computed before any fragment is dropped: whether the LINE budget was full is a fact about the
  // read, not about what survived the cleanup below.
  const lineBudgetFull = split.length >= lines;

  /*
    Drop the line the byte cut landed inside, rather than parsing a fragment as a log line.

    Which end is cut is not documented and differs by kubelet path (`tailLines` seeks to the tail
    and then limits bytes, so the tail end is the usual casualty; a plain byte limit cuts the head).
    Rather than assume, both ends are checked for evidence of a fragment and only a line with such
    evidence is dropped: a trailing line when the body did not end in a newline, and a leading line
    with no RFC3339 stamp when stamps were requested. No evidence, nothing dropped.
  */
  let partialLinesDropped = 0;
  if (bytesTruncated && split.length > 0) {
    if (!raw.endsWith('\n')) {
      split.pop();
      partialLinesDropped += 1;
    }
    if (timestamps && split.length > 0 && !TIMESTAMP_PREFIX.test(split[0])) {
      split.shift();
      partialLinesDropped += 1;
    }
  }

  const parsed = split.map(parseLine);

  return {
    cluster: cluster.id, namespace, pod, container: container || null,
    previous, tailLines: lines,
    /** The LINE budget was full — older lines exist beyond it. */
    truncated: lineBudgetFull,
    /** The BYTE budget was reached. Independent of the line budget, and never implied by it. */
    bytesTruncated,
    bytesRead,
    limitBytes: LOG_LIMIT_BYTES,
    /**
     * Lines removed because the byte cut landed inside them. Reported rather than silent: a missing
     * line an operator knows about is a gap; a fragment rendered as a line is a wrong log entry.
     */
    partialLinesDropped,
    lines: parsed,
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Split the RFC3339 stamp the API server prefixes when timestamps=true, and take a guess
 * at severity so the UI can colour the line. The guess is intentionally shallow — regexing
 * arbitrary application output into structure is a losing game, and getting it wrong on a
 * line that says "no errors found" is worse than not colouring at all.
 */
function parseLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?([\s\S]*)$/.exec(line);
  const at = match ? match[1] : null;
  const message = match ? match[2] : line;

  let level = null;
  if (/\b(FATAL|PANIC)\b/.test(message)) level = 'fatal';
  else if (/\b(ERROR|ERR)\b|\bException\b/.test(message)) level = 'error';
  else if (/\b(WARN|WARNING)\b/.test(message)) level = 'warn';
  else if (/\b(DEBUG|TRACE)\b/.test(message)) level = 'debug';

  return { at, level, message };
}

export default { inventory, tail, parseLine, MAX_TAIL_LINES, DEFAULT_TAIL_LINES, LOG_LIMIT_BYTES };
