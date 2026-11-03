
/**
 * Health findings per summary group — the number the owning collector already computed.
 *
 * ## Why this file exists
 *
 * `groupState()` in `router.js` answers **"did the read succeed?"** — it looks at `r.ok` and at
 * the `unavailable` union, and never at `r.data`. That is the right question for a completeness
 * contract and the wrong question for an operator, because the two answers come apart in the
 * worst possible direction: a cluster whose every read is granted and answers cleanly, and which
 * happens to have two containers in CrashLoopBackOff, reports `ok` on all seventeen groups. The
 * Overview then renders seventeen green pills and the sentence "Nothing to triage on this
 * cluster" while the thing the operator came to find sits one tab away.
 *
 * So a tile needs two verdicts, not one:
 *
 *   reads   — completeness. Did we see everything? (`groupState` + `unavailable`/`truncated`)
 *   health  — is what we saw healthy? (this file)
 *
 * They are deliberately separate all the way to the pixel. "3 crashlooping" and "we could not
 * read pods" are different sentences and collapsing them into one colour is how a console starts
 * lying.
 *
 * ## This does not re-derive anything
 *
 * Rule 3 of the implementation rules is *one owner per fact*, and this file honours it rather
 * than bending it: every number below is read straight out of the owning collector's own payload,
 * from the same fan-out result and the same cache entry the tab behind the tile reads. Nothing
 * here recomputes a verdict from raw Kubernetes objects. If `reliability.js` changes how it
 * counts a crashloop, this changes with it and the tile cannot drift from the tab.
 *
 * ## The zero rule
 *
 * A finding is emitted **only** for a finite number greater than zero. `null` and `undefined`
 * produce no finding at all, because that is what a collector returns when the read behind the
 * number failed — several deliberately return `null` rather than `0` for exactly this reason
 * (`certificates.summary.totalCertificates`). Turning that into a
 * finding of `0` would reintroduce the confident-zero bug at the one layer whose whole job is to
 * decide what the operator is told. The honesty about *that* gap travels on `unavailable`.
 *
 * A genuine `0` also produces no finding, which is the point: the attention list is the topics
 * that are not clean, and a clean topic has nothing to say.
 */

/** Someone should look at this now. */
const BAD = 'bad';
/** Worth knowing, not an incident. */
const WARN = 'warn';

/**
 * How a finding combines across clusters on the **fleet-wide** `/summary`.
 *
 * Counts sum — "2 containers crashlooping" over two clusters is a meaningful fleet total. Rates do
 * not: two clusters at 100% coverage-gap summed to **"200% of namespaces have no ResourceQuota"**,
 * which is the confidently-wrong-number failure mode wearing a different hat.
 *
 * The fix is the worst value, not the mean. An unweighted mean of percentages taken over clusters
 * of different sizes is also wrong, and the weighted mean is unavailable *by construction* — a rate
 * exists here precisely because the owning collector does not publish the denominator it divided
 * by. `MAX` claims only what it can defend ("at worst, this much, in these clusters"), and the
 * label picks up "(worst of N clusters)" once more than one cluster contributes so the number is
 * not read as true of every cluster named.
 */
const MAX = 'max';

/** Internal bookkeeping that must never reach the client. */
const INTERNAL_FIELDS = ['forms', 'merge'];

/**
 * A finding, or `null`.
 *
 * @param {*} count the owner's number — anything non-finite or <= 0 yields no finding
 * @param {string|[string, string]} label what the number counts, phrased so
 *   `${count}${unit} ${label}` reads as English ("3 containers crashlooping", "40% of namespaces
 *   with no ResourceQuota"). Pass `[singular, plural]` for anything that has to agree with the
 *   count — an operator console that prints "1 nodes not ready" reads as unfinished, and the
 *   irregulars here ("1 StatefulSet behind its spec", "1 HPA at its maximum") rule out deriving
 *   the singular from the plural.
 * @param {'bad'|'warn'} tone
 * @param {string} [unit] appended to the number with no space — only `'%'` today, which needs no
 *   agreement ("1% of namespaces" is correct), so percentage labels stay plain strings. A unit also
 *   makes the finding a **rate**, which changes how it merges across clusters — see `MAX`.
 */
function f(count, label, tone, unit) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  const forms = Array.isArray(label) ? label : null;
  // The **plural** is the canonical form, and it is what `label` carries until the very end.
  // `signalsOf` merges the same finding across clusters by label, so the merge key must not
  // depend on the count: keying on a per-cluster singular would leave "1 container crashlooping"
  // and "2 containers crashlooping" as two separate findings that never sum. The agreeing form is
  // chosen once, after the fleet-wide total is known, and `forms` is dropped there — it never
  // reaches the wire.
  const one = { label: forms ? forms[1] : label, count, tone };
  if (unit) {
    one.unit = unit;
    one.merge = MAX;
  }
  if (forms) one.forms = forms;
  return one;
}

/**
 * A finding with no count — a condition that is its own answer ("single availability zone").
 * Only ever fires on a literal `true`, so an unresolved `null` stays silent.
 */
function flag(on, label, tone) {
  return on === true ? { label, count: null, tone } : null;
}

/** `total - part`, but only when both are real numbers. Unread on either side means silence. */
function gap(total, part) {
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  if (typeof part !== 'number' || !Number.isFinite(part)) return null;
  return total - part;
}

/** Length of an array, or `null` for anything else — collectors use `null` for "unread". */
function len(v) {
  return Array.isArray(v) ? v.length : null;
}

/** How many items of an array satisfy a predicate, or `null` when it is not an array. */
function count(v, pred) {
  return Array.isArray(v) ? v.filter(pred).length : null;
}

/**
 * One HPA's state, in the buckets the Autoscaling tab's Status pill resolves to (`hpaStatus` in
 * app/fleet-ui/src/pages/cluster-tabs/autoscaling-format.ts), so the tile and the tab count alike:
 *
 *  - `failing`: `AbleToScale=False`, or `ScalingActive` not `True` (bar a deliberate
 *    `ScalingDisabled`) — "Cannot scale target" / "No readable metric".
 *  - `ceiling`: `ScalingLimited=True` with reason `TooManyReplicas`, or limited for a reason the
 *    tab does not recognise while `current >= max` — "At ceiling".
 *  - `fixed`: `minReplicas == maxReplicas` — "Fixed at N", a configuration choice.
 *  - `other`: no conditions yet, `ScalingDisabled`, or limited with the bound unreported.
 *  - `scaling`: everything else — "Active", including an HPA held at its floor.
 *
 * @returns {'failing'|'ceiling'|'fixed'|'other'|'scaling'}
 */
function hpaState(h) {
  const conditions = Array.isArray(h && h.conditions) ? h.conditions : [];
  if (!conditions.length) return 'other';
  const find = type => conditions.find(c => c && c.type === type);
  const able = find('AbleToScale');
  if (able && able.status === 'False') return 'failing';
  const active = find('ScalingActive');
  if (active && active.status === 'False' && active.reason === 'ScalingDisabled') return 'other';
  if (!active || active.status !== 'True') return 'failing';
  const limited = conditions.find(c => c && c.type === 'ScalingLimited' && c.status === 'True');
  const reason = limited ? limited.reason : null;
  if (reason === 'TooManyReplicas') return 'ceiling';
  if (typeof h.minReplicas === 'number' && h.minReplicas === h.maxReplicas) return 'fixed';
  if (['TooFewReplicas', 'ScaleUpLimit', 'ScaleDownLimit'].includes(reason)) return 'scaling';
  const known = typeof h.maxReplicas === 'number' && typeof h.currentReplicas === 'number';
  if (limited) return !known ? 'other' : h.currentReplicas >= h.maxReplicas ? 'ceiling' : 'scaling';
  return 'scaling';
}

/**
 * One rule per summary group. Each takes the owning collector's `data` and returns findings;
 * `null` entries are dropped by `signalsOf`.
 *
 * Every group has a rule. A group without one would render as a confident "OK" backed by no
 * check at all, which is the exact failure this file was written to remove — so if a new group
 * joins `SUMMARY_GROUPS`, the test in `server/fleet/__tests__/signals.test.js` fails until it appears here.
 *
 * Findings are partitioned so that no number appears under two topics. The temptation was to
 * report pending pods under both `health` (which owns the pod phase rollup) and `capacity`
 * (which owns *why* one is pending); it is reported once, by `health`, and `capacity` speaks
 * only about headroom. Same for node readiness, which `health` owns and `topology` therefore
 * does not repeat.
 */
const RULES = {
  health: d => {
    const n = d.nodes || {};
    const p = d.pods || {};
    return [
      f(gap(n.total, n.ready), ['node not ready', 'nodes not ready'], BAD),
      f(p.failed, ['pod failed', 'pods failed'], BAD),
      f(n.withProblems, ['node reporting a problem condition', 'nodes reporting a problem condition'], WARN),
      f(p.pending, ['pod pending', 'pods pending'], WARN),
      f(n.unschedulable, ['node cordoned', 'nodes cordoned'], WARN)
    ];
  },

  // `verdict: 'unknown'` means the pod sweep failed, so every array below is empty by
  // construction rather than by a clean cluster — a finding of 0 there would be fabricated.
  reliability: d => {
    const s = d.summary || {};
    if (s.verdict === 'unknown') return [];
    return [
      // `crashLoops` is a count of *containers* (`crashLoopsForPod` pushes one entry per
      // containerStatus), not of pods — the label says so rather than leaving it to be guessed.
      f(s.crashLoops, ['container crashlooping', 'containers crashlooping'], BAD),
      f(s.underCapacity, ['workload under desired replicas', 'workloads under desired replicas'], BAD),
      f(s.zeroEndpointServices, ['service with no ready endpoint', 'services with no ready endpoint'], BAD),
      f(s.daemonSetsStuck, ['DaemonSet stuck mid-rollout', 'DaemonSets stuck mid-rollout'], WARN),
      f(s.driftedDeployments, ['Deployment with an unfinished rollout', 'Deployments with an unfinished rollout'], WARN),
      f(s.staleStatefulSets, ['StatefulSet behind its spec', 'StatefulSets behind their spec'], WARN)
    ];
  },

  workloads: d => [f((d.summary || {}).notReady, ['workload not ready', 'workloads not ready'], BAD)],

  // A Gateway its controller has not programmed serves nothing, whatever routes point at it.
  // `null` (no verdict yet) is not counted: an unreconciled object is not a failed one.
  networking: d => [
    f(count(d.gateways, g => g.programmed === false), ['Gateway not programmed', 'Gateways not programmed'], BAD),
    f(count(d.httproutes, r => r.accepted === false), ['HTTPRoute not accepted by its Gateway', 'HTTPRoutes not accepted by their Gateway'], WARN)
  ],

  storage: d => {
    const s = d.summary || {};
    const sc = s.defaultStorageClassState || {};
    return [
      f(s.pendingPvcs, ['PVC pending', 'PVCs pending'], BAD),
      flag(sc.state === 'missing', 'no default StorageClass', WARN),
      flag(sc.state === 'ambiguous', 'more than one default StorageClass', WARN),
      // `quotaCoverage` is a ratio of namespaces, and the owner does not publish the namespace
      // total it was divided by — so the shortfall is reported as the percentage it is, not as a
      // namespace count reverse-engineered out of `quotasCount` (which counts quota *objects*,
      // several of which can live in one namespace, and would give a confidently wrong number).
      f(
        typeof s.quotaCoverage === 'number' && s.quotaCoverage < 1
          ? Math.round((1 - s.quotaCoverage) * 100)
          : null,
        'of namespaces have no ResourceQuota',
        WARN,
        '%'
      )
    ];
  },

  security: d => {
    const s = d.summary || {};
    return [
      f(s.privilegedContainers, ['privileged container', 'privileged containers'], BAD),
      f(
        gap(s.appNamespacesAudited, s.networkPolicyProtectedNamespaces),
        ['app namespace with no NetworkPolicy', 'app namespaces with no NetworkPolicy'],
        WARN
      )
    ];
  },

  compliance: d => {
    const s = d.summary || {};
    return [
      f(s.withFindings, ['namespace with findings', 'namespaces with findings'], BAD),
      f(s.withWarnings, ['namespace with warnings', 'namespaces with warnings'], WARN)
    ];
  },

  // An HPA pinned at its ceiling cannot answer more load, which is the one HPA fact worth
  // surfacing without opening the tab.
  // Classified by `hpaState`, the controller's own reason, never `current >= max`: that test
  // painted every min == max autoscaler held at its floor as "at its maximum".
  autoscaling: d => [
    f(count(d.hpas, h => hpaState(h) === 'failing'), ['HPA not scaling', 'HPAs not scaling'], BAD),
    f(count(d.hpas, h => hpaState(h) === 'ceiling'), ['HPA at its maximum', 'HPAs at their maximum'], WARN)
  ],

  certificates: d => {
    const s = d.summary || {};
    return [
      f(s.expired, ['certificate expired', 'certificates expired'], BAD),
      f(s.expiringSoon, ['certificate expiring soon', 'certificates expiring soon'], BAD),
      f(s.unready, ['certificate not ready', 'certificates not ready'], WARN)
    ];
  },

  // Node readiness belongs to `health`; this speaks only about spread.
  topology: d => [flag((d.summary || {}).isMultiZone === false, 'single availability zone', WARN)],

  mesh: d => {
    const b = d.ingressBindingIntegrity || {};
    const a = d.authorizationPosture || {};
    const cov = d.sidecarCoverage || {};
    return [
      f(
        len(b.virtualServicesWithMissingGateway),
        ['VirtualService bound to a missing Gateway', 'VirtualServices bound to a missing Gateway'],
        BAD
      ),
      f(len(b.duplicateHostExposures), ['host exposed by more than one route', 'hosts exposed by more than one route'], BAD),
      f(
        len(a.unenforceablePolicies),
        ['AuthorizationPolicy that cannot be enforced', 'AuthorizationPolicies that cannot be enforced'],
        BAD
      ),
      f(len(b.unboundGateways), ['Gateway nothing routes to', 'Gateways nothing routes to'], WARN),
      // PERMISSIVE accepts plaintext. Read off the owner's verdict list, never re-resolved here.
      f(
        count(d.mtls, v => v && typeof v.mode === 'string' && v.mode.toUpperCase() === 'PERMISSIVE'),
        ['mTLS scope set to PERMISSIVE', 'mTLS scopes set to PERMISSIVE'],
        WARN
      ),
      f(
        typeof cov.coveragePercent === 'number' && cov.coveragePercent < 100 ? 100 - cov.coveragePercent : null,
        'of meshable pods have no sidecar',
        WARN,
        '%'
      )
    ];
  },

  // Pod-level pressure is `health`'s; this is about limits and measurability.
  capacity: d => {
    const u = d.unboundedContainers || {};
    const m = d.metricsServer || {};
    return [
      f(
        u.noEitherLimit,
        ['container with neither CPU nor memory limit', 'containers with neither CPU nor memory limit'],
        WARN
      ),
      flag(m.installed === true && m.reporting === false, 'metrics-server installed but not reporting', WARN),
      // `installed === null` means the probe itself could not complete — a 403 from role drift,
      // or an upstream failure. Distinct from "installed but down", and it used to produce no
      // finding at all, so a denied usage read looked identical to a healthy one.
      flag(m.installed === null, 'metrics-server could not be read, so usage figures are missing', WARN)
    ];
  },

  observability: d => {
    const t = d.telemetry || {};
    const kinds = [t.logPipelines, t.tracePipelines, t.metricPipelines].filter(p => p && typeof p === 'object');
    const sum = key => (kinds.length ? kinds.reduce((n, p) => n + (typeof p[key] === 'number' ? p[key] : 0), 0) : null);
    return [
      f(sum('notReady'), ['telemetry pipeline not ready', 'telemetry pipelines not ready'], BAD),
      // Ready but not actually shipping — deliberately its own count in the owner, kept separate.
      f(
        sum('flowUnhealthy'),
        ['telemetry pipeline with an unhealthy flow', 'telemetry pipelines with an unhealthy flow'],
        BAD
      ),
      f(sum('indeterminate'), ['telemetry pipeline with no verdict', 'telemetry pipelines with no verdict'], WARN)
    ];
  },

};

/**
 * The findings for one group, worst first.
 *
 * @param {string} key a `SUMMARY_GROUPS` key
 * @param {Array<{ok: boolean, data?: object}>} results the fan-out results for that group
 * @returns {Array<{label: string, count: number|null, tone: 'bad'|'warn', clusters?: string[]}>}
 */
function signalsOf(key, results) {
  const rule = RULES[key];
  if (!rule) return [];
  const merged = new Map();
  for (const r of results || []) {
    // A cluster that did not answer contributes nothing rather than a zero — its silence is
    // already reported by `groupState` and the `unavailable` union.
    if (!r || !r.ok || !r.data) continue;
    // `runFanOut` returns `cluster: publicCluster(cluster)`, so the id is nested. On a
    // per-cluster summary there is only ever one result and this list is a formality; it is
    // what makes the same function usable for the fleet-wide dots.
    const at = r.cluster && r.cluster.id;
    let found;
    try {
      found = rule(r.data) || [];
    } catch {
      // A collector shape that moved should degrade to "no health signal", never take the
      // whole summary response down with it. The completeness verdict still reports honestly.
      continue;
    }
    for (const one of found) {
      if (!one) continue;
      const seen = merged.get(one.label);
      if (!seen) {
        merged.set(one.label, { ...one, clusters: at ? [at] : [] });
        continue;
      }
      // Fleet-wide, the same finding from several clusters combines, and the worse tone wins.
      // Counts sum; rates take the worst value — see `MAX` for why the mean is not an option.
      if (typeof one.count === 'number' && typeof seen.count === 'number') {
        seen.count = seen.merge === MAX ? Math.max(seen.count, one.count) : seen.count + one.count;
      }
      if (one.tone === BAD) seen.tone = BAD;
      if (at && !seen.clusters.includes(at)) seen.clusters.push(at);
    }
  }
  return [...merged.values()]
    .sort((a, b) => (a.tone === b.tone ? (b.count || 0) - (a.count || 0) : a.tone === BAD ? -1 : 1))
    .map(one => {
      // Phrasing is decided here, against the merged total, and the internals leave with it.
      const out = { ...one };
      if (one.forms) out.label = one.count === 1 ? one.forms[0] : one.forms[1];
      // The UI renders `${count}${unit} ${label}`, so the qualifier has to sit *after* the number:
      // "100% of namespaces have no ResourceQuota [platformsbx, demo-dev]" would otherwise read as
      // both clusters being at 100%. One of them is; this is the worst of the two.
      if (one.merge === MAX && out.clusters.length > 1) {
        out.label = `${out.label} (worst of ${out.clusters.length} clusters)`;
      }
      for (const field of INTERNAL_FIELDS) delete out[field];
      return out;
    });
}

/**
 * The tile's single verdict, from both halves.
 *
 * `unknown` outranks everything because a group nobody could read has no health to report, and
 * saying "clear" there would be the confident green this whole file exists to prevent. Below
 * that, a real finding outranks an incomplete read: "3 crashlooping" is more actionable than
 * "one of five reads was refused", and the refusal is still printed beside it.
 *
 * @param {'ok'|'degraded'|'error'} reads the completeness verdict from `groupState`
 * @param {Array<{tone: string}>} signals
 * @returns {'unknown'|'attention'|'warn'|'partial'|'clear'}
 */
function healthOf(reads, signals) {
  if (reads === 'error') return 'unknown';
  if (signals.some(s => s.tone === BAD)) return 'attention';
  if (signals.some(s => s.tone === WARN)) return 'warn';
  return reads === 'degraded' ? 'partial' : 'clear';
}

// ------------------------------------------------------------------------------ tile stats

/** A finite number, or `null` — collectors use `null` for "unread", and so does every stat. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One headline count. `label` is `[singular, plural]` or a plain string; `null` counts render as
 * "unavailable". `tone` is set only when the count is a deviation (above zero, or below `of`).
 */
function h(count, label, tone, of) {
  const c = num(count);
  const text = Array.isArray(label) ? (c === 1 ? label[0] : label[1]) : label;
  const out = { count: c, label: text };
  if (of !== undefined) out.of = num(of);
  const deviates = of !== undefined ? c !== null && num(of) !== null && c < of : c !== null && c > 0;
  if (tone && deviates) out.tone = tone;
  return out;
}

/**
 * Whether a list the collector read was refused. Collectors report a refused list as `[]` and its
 * label in `unavailable` (top level or under `summary`), so a count built from it is 0 by
 * construction; a rule asks this first and sends `null` instead. A per-namespace label
 * (`deployments[ns=a]`) counts as its base list.
 */
function refused(d, ...bases) {
  const labels = [d.unavailable, d.summary && d.summary.unavailable].flatMap(l => (Array.isArray(l) ? l : []));
  return labels.some(l => typeof l === 'string' && bases.some(b => l === b || l.startsWith(`${b}[`)));
}

/** `v` unless one of the named lists was refused. */
function unless(d, bases, v) {
  return refused(d, ...bases) ? null : v;
}

/** A split bar over `total`; `null` when the total is unread, so the bar never draws a zero. */
function split(total, parts) {
  const t = num(total);
  if (t === null || parts.some(p => num(p[2]) === null)) return null;
  return { total: t, parts: parts.map(([key, label, n, tone]) => ({ key, label, count: n, tone })) };
}

/**
 * The Overview tiles' high-level stats: what the tile shows under its verdict, so a deviation reads
 * before the tile is opened. One rule per Overview topic (`TOPICS` in
 * app/fleet-ui/src/pages/cluster-tabs/OverviewTab.tsx; server/fleet/__tests__/overview-stats.test.js holds the
 * two lists equal). Each reads the same collector payload its signal rule does, so a count here
 * and the finding beside it are one number.
 *
 * Tones: `ok`, `warn`, `bad` as the verdicts use them; `neutral` for a state that is fine but not
 * "healthy" (a completed pod, a fixed HPA); `unknown` for no verdict at all.
 */
const STATS = {
  health: d => {
    const n = d.nodes || {};
    // A refused pod list still arrives as `pods.total: 0` (`requiredList` in health.js).
    const p = refused(d, 'pods') ? null : d.pods || null;
    const known = p ? [p.running, p.pending, p.failed, p.succeeded].map(v => num(v) ?? 0) : [];
    return {
      headline: [h(n.ready, ['node ready', 'nodes ready'], BAD, n.total), h(p && p.total, ['pod', 'pods'])],
      split: p ? split(p.total, [
        ['running', 'running', known[0], 'ok'],
        ['pending', 'pending', known[1], 'warn'],
        ['failed', 'failed', known[2], 'bad'],
        ['succeeded', 'completed', known[3], 'neutral'],
        // `Unknown` or no phase at all (a node that lost contact): counted in the total, so drawn.
        ['otherPhase', 'unknown phase', Math.max(0, gap(p.total, known.reduce((a, b) => a + b, 0)) ?? 0), 'unknown']
      ]) : null
    };
  },

  workloads: d => {
    const s = d.summary || {};
    // Every controller list feeds both counts; a refused one would undercount them silently.
    const controllers = ['deployments', 'statefulsets', 'daemonsets'];
    const total = unless(d, controllers, num(s.total));
    const notReady = unless(d, controllers, num(s.notReady));
    return {
      // Restarts are lifetime counts since each container started, so any size is normal on a
      // long-lived cluster: shown for scale, never toned as a deviation.
      headline: [h(total, ['workload', 'workloads']), h(notReady, 'not ready', BAD), h(unless(d, ['pods'], s.restarts), ['container restart', 'container restarts'])],
      split: split(total, [
        ['ready', 'ready', gap(total, notReady), 'ok'],
        ['notReady', 'not ready', notReady, 'bad']
      ])
    };
  },

  autoscaling: d => {
    if (!Array.isArray(d.hpas)) throw new TypeError('hpas is not a list');
    const s = d.summary || {};
    const by = { scaling: 0, ceiling: 0, failing: 0, fixed: 0, other: 0 };
    for (const one of d.hpas) by[hpaState(one)]++;
    const hpasRead = !refused(d, 'hpa');
    return {
      headline: [
        h(hpasRead ? s.totalHpas ?? d.hpas.length : null, ['HPA', 'HPAs']),
        h(hpasRead ? by.ceiling : null, 'at ceiling', WARN),
        h(unless(d, ['cronjobs'], s.totalCronJobs), ['CronJob', 'CronJobs'])
      ],
      split: split(hpasRead ? d.hpas.length : null, [
        ['scaling', 'scaling', by.scaling, 'ok'],
        ['ceiling', 'at ceiling', by.ceiling, 'warn'],
        ['failing', 'not scaling', by.failing, 'bad'],
        ['fixed', 'fixed', by.fixed, 'neutral'],
        ['other', 'no verdict', by.other, 'unknown']
      ])
    };
  },

  networking: d => {
    const s = d.summary || {};
    return {
      headline: [
        h(unless(d, ['ingresses'], s.ingressesCount), ['Ingress', 'Ingresses']),
        h(unless(d, ['httproutes'], s.httproutesCount), ['HTTPRoute', 'HTTPRoutes']),
        h(unless(d, ['gateways'], s.gatewaysCount), ['Gateway', 'Gateways']),
        h(unless(d, ['virtualservices'], s.virtualServicesCount), ['VirtualService', 'VirtualServices']),
        h(unless(d, ['services'], s.servicesCount), ['Service', 'Services'])
      ],
      split: null
    };
  },

  certificates: d => {
    // A refused certificate list makes every count below a zero by construction.
    if (refused(d, 'certificates')) {
      return { headline: [h(null, 'certificates'), h(null, 'expiring soon'), h(null, 'expired')], split: null };
    }
    const s = d.summary || {};
    const certs = Array.isArray(d.certificates) ? d.certificates : null;
    // Each certificate lands in its worst state once, so the parts sum to the total; the summary's
    // own counts overlap (an expired certificate is usually also expiring and unready).
    const by = { valid: 0, expiring: 0, unready: 0, expired: 0 };
    for (const c of certs || []) {
      by[c.isExpired ? 'expired' : c.isReady === false ? 'unready' : c.isExpiringSoon ? 'expiring' : 'valid']++;
    }
    return {
      headline: [h(s.totalCertificates, ['certificate', 'certificates']), h(s.expiringSoon, 'expiring soon', BAD), h(s.expired, 'expired', BAD)],
      split: certs ? split(certs.length, [
        ['valid', 'valid', by.valid, 'ok'],
        ['expiring', 'expiring soon', by.expiring, 'warn'],
        ['unready', 'not ready', by.unready, 'warn'],
        ['expired', 'expired', by.expired, 'bad']
      ]) : null
    };
  }
};

/** Any completeness list on the payload that is non-empty — top level or under `summary`. */
function truncatedAnywhere(d) {
  const lists = [d.truncated, d.summary && d.summary.truncated];
  return lists.some(l => Array.isArray(l) && l.length > 0);
}

/**
 * One cluster's tile stats for a group, or `null`.
 *
 * `null` whenever the answer would be invented: no rule for the group, not exactly one result (the
 * fleet-wide sweep summarises many clusters, and a sum across them is a different number), a read
 * that failed, or a payload whose shape the rule no longer recognises. `atLeast` marks every count
 * as a floor when any list behind it stopped at the paging ceiling.
 *
 * @param {string} key a `SUMMARY_GROUPS` key
 * @param {Array<{ok: boolean, data?: object}>} results
 */
function statsOf(key, results) {
  const rule = STATS[key];
  if (!rule || !Array.isArray(results) || results.length !== 1) return null;
  const [r] = results;
  if (!r || !r.ok || !r.data) return null;
  try {
    const out = rule(r.data);
    if (!out) return null;
    return { headline: out.headline, split: out.split, atLeast: truncatedAnywhere(r.data) };
  } catch {
    return null;
  }
}

export default {
  signalsOf,
  healthOf,
  statsOf,
  hpaState,
  RULES,
  SIGNAL_GROUP_KEYS: Object.keys(RULES),
  STAT_GROUP_KEYS: Object.keys(STATS)
};
