/**
 * Kyma module inventory: which modules are installed on a cluster, and are they current.
 *
 * Everything here reads exactly one CR family: `operator.kyma-project.io/v1beta2` `Kyma`
 * (the cluster's own module manifest) joined against `moduleReleaseMetas` (the channel
 * catalog that says which version is "current" on which channel). Both are Kyma-runtime
 * CRDs that only exist on a Kyma-managed cluster, so a 404 on either is a true zero exactly
 * the way safeList already treats it: the module system is not installed here.
 *
 * The one case that is NOT a true zero: a cluster whose CRD is served (so it is at least
 * Kyma-aware) but whose `kymas` list comes back empty. That is not "zero modules installed
 * cleanly" — every Kyma-managed cluster has exactly one Kyma CR (conventionally
 * `default`/`kyma-system`), so an empty list here means either the CR was deleted out from
 * under a still-registered CRD, or this cluster was never actually onboarded to Kyma despite
 * having the operator's CRDs registered. Reporting `0 modules` would read as "healthy Kyma
 * cluster, nothing installed", which is not what happened and is worth flagging on its own.
 * See `kymaManaged: null` below.
 *
 * Deliberately NOT implemented: a staleness check comparing `status.observedGeneration` to
 * `metadata.generation`. On a real, healthy Kyma CR these differ constantly — the reconciler
 * only bumps `observedGeneration` on a full pass, while `generation` increments on every spec
 * write, including ones the reconciler doesn't need to react to — so `observedGeneration: 1`
 * against `generation: 11` is normal, not stale. Building this check would be a 100%
 * false-positive finding against every real cluster tested.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, absentList, unavailableLabels, truncatedLabels } = safeListModule;

const KYMA_GROUP = 'operator.kyma-project.io';
const KYMA_VERSION = 'v1beta2';
const KYMAS_PATH = `/apis/${KYMA_GROUP}/${KYMA_VERSION}/kymas`;
// Kubernetes collection paths are the CRD's lowercase plural, and the API server is
// case-sensitive about it. `moduleReleaseMetas` — the camelCase spelling the Kyma docs and Go
// types use — 404s, which `safeList` correctly reports as unavailable. That rendered every
// module card on the live cluster as "the token may have expired or the read may be
// forbidden" while `kymas` beside it read fine and the RBAC rule granted the resource.
const MRM_PATH = `/apis/${KYMA_GROUP}/${KYMA_VERSION}/modulereleasemetas`;

const KYMAS_LABEL = 'kymas';
const MRM_LABEL = 'modulereleasemetas';

/** The three currency verdicts B2 produces. Nothing else is a legal value of this field. */
const BEHIND = 'behind';
const CURRENT = 'current';
const AHEAD = 'ahead';

/**
 * Parse a `major.minor.patch`-shaped version string into three integers for a segment-wise
 * comparison. A naive string compare inverts real results — lexicographically '1.9.11' >
 * '1.10.0' because '9' > '1' as characters — so every segment must be compared as a number,
 * never as text. Trailing pre-release/build metadata (`-rc1`, `+build5`) is stripped from the
 * last numeric segment before parsing; anything that still fails to parse comes back null,
 * which the caller must treat as "cannot compare", not as zero.
 */
function parseVersion(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  const segments = cleaned.split('.').slice(0, 3);
  const numbers = segments.map(seg => {
    const digits = seg.match(/^\d+/);
    return digits ? Number(digits[0]) : NaN;
  });
  if (numbers.some(n => !Number.isFinite(n))) return null;
  while (numbers.length < 3) numbers.push(0);
  return numbers;
}

/**
 * Segment-wise integer comparison. Returns -1/0/1 like a normal comparator, or null when
 * either side could not be parsed — a caller must not guess a direction for that case.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** B2: behind | current | ahead, or null when either version string didn't parse. */
function currencyOf(installedVersion, catalogVersion) {
  const cmp = compareVersions(installedVersion, catalogVersion);
  if (cmp === null) return null;
  if (cmp < 0) return BEHIND;
  if (cmp > 0) return AHEAD;
  return CURRENT;
}

/**
 * Index moduleReleaseMetas by module name -> { [channel]: version }, the shape B2's join
 * needs. A MRM's `spec.channels` is itself an array of {channel, version}; malformed entries
 * are skipped rather than thrown on, since this is a catalog read, not the thing being audited.
 */
function buildChannelCatalog(mrmItems) {
  const catalog = new Map();
  for (const mrm of mrmItems) {
    const name = mrm.spec && mrm.spec.module;
    if (!name) continue;
    const channels = (mrm.spec && mrm.spec.channels) || [];
    const byChannel = catalog.get(name) || {};
    for (const entry of channels) {
      if (entry && typeof entry.channel === 'string' && typeof entry.version === 'string') {
        byChannel[entry.channel] = entry.version;
      }
    }
    catalog.set(name, byChannel);
  }
  return catalog;
}

/**
 * B1: join the Kyma CR's declarative `spec.modules[]` (what the operator was asked to
 * manage) against `status.modules[]` (what it actually reconciled), by name. A module can
 * appear in only one of the two — requested-but-not-yet-reconciled, or reconciled-but-since
 * removed from spec (still running until GC catches up) — and both are real states worth
 * reporting rather than silently dropping one side of the join.
 */
function joinModules(kyma) {
  const spec = (kyma.spec && kyma.spec.modules) || [];
  const status = (kyma.status && kyma.status.modules) || [];

  const specByName = new Map(spec.filter(m => m && m.name).map(m => [m.name, m]));
  const statusByName = new Map(status.filter(m => m && m.name).map(m => [m.name, m]));

  const names = new Set([...specByName.keys(), ...statusByName.keys()]);
  return [...names].sort().map(name => {
    const specEntry = specByName.get(name) || null;
    const statusEntry = statusByName.get(name) || null;
    return {
      name,
      // managed: whether the Kyma CR's spec is currently asking for this module. A module
      // present only in status is being phased out (or was removed by hand), not "managed".
      managed: Boolean(specEntry),
      channel: (statusEntry && statusEntry.channel) || (specEntry && specEntry.channel) || null,
      version: (statusEntry && statusEntry.version) || null,
      state: (statusEntry && statusEntry.state) || null,
      requestedChannel: (specEntry && specEntry.channel) || null
    };
  });
}

/**
 * B1+B2 for one Kyma CR: join its modules against the channel catalog and attach a currency
 * verdict to each. `resource` is the minimal projection the UI needs to identify the CR
 * itself, per the task's required shape.
 */
function projectKyma(kyma, catalog) {
  const modules = joinModules(kyma).map(m => {
    const byChannel = m.channel ? catalog.get(m.name) : null;
    const catalogVersion = byChannel && m.channel ? byChannel[m.channel] || null : null;
    return {
      ...m,
      catalogVersion,
      currency: m.version && catalogVersion ? currencyOf(m.version, catalogVersion) : null
    };
  });

  return {
    resource: {
      apiVersion: `${KYMA_GROUP}/${KYMA_VERSION}`,
      kind: 'Kyma',
      metadata: {
        name: kyma.metadata && kyma.metadata.name,
        namespace: kyma.metadata && kyma.metadata.namespace
      }
    },
    channel: (kyma.spec && kyma.spec.channel) || null,
    state: (kyma.status && kyma.status.state) || null,
    modules
  };
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: typeof call}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, listFn = list, callFn }) {
  const baseCtx = { cluster, token };
  const [kymasResult, mrmResult] = await Promise.all([
    // absentList (not plain safeList): a bare 404 on kymas is ambiguous between "the operator
    // CRD isn't installed here at all" (a healthy non-Kyma cluster) and "the CRD is served but
    // no Kyma CR exists" (the anomaly this module exists to flag) — only the group-discovery
    // probe tells the two apart. Without callFn the probe cannot run and `absent` stays null,
    // which this collector then treats the same as "unresolved", per the doc above.
    absentList(listFn, baseCtx, KYMAS_PATH, KYMAS_LABEL, { group: KYMA_GROUP, version: KYMA_VERSION, callFn }),
    safeList(listFn, baseCtx, MRM_PATH, MRM_LABEL)
  ]);

  const catalog = buildChannelCatalog(mrmResult.items);
  const kymas = kymasResult.items.map(k => projectKyma(k, catalog));

  // absent === true: the CRD's group is confirmed not registered — a genuinely non-Kyma
  // cluster, and 0 modules is the honest, healthy answer for it.
  // absent === false with zero items: the group serves this CRD and the list genuinely
  // came back empty — the anomaly the module doc describes, never presented as a clean zero.
  // absent === null (probe inconclusive, or no callFn to run it): unresolved either way.
  const emptyAndUnresolved = !kymasResult.unavailable && kymasResult.items.length === 0 && kymasResult.absent !== true;

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      kymaCount: kymas.length,
      moduleCount: kymas.reduce((sum, k) => sum + k.modules.length, 0),
      // null (not true/false) is deliberate: an unreadable kymas list, or one we could not
      // resolve as CRD-absent-vs-served-empty, means we don't know either way — and false
      // would read as "confirmed not Kyma-managed", which we cannot say in that case.
      kymaManaged: kymasResult.unavailable ? null : (emptyAndUnresolved ? null : (kymasResult.absent === true ? false : true)),
      unreadableReason: emptyAndUnresolved
        ? { reason: kymasResult.absentProbeReason || 'UPSTREAM', detail: 'CRD served, no Kyma CR exists' }
        : null,
      unavailable: unavailableLabels([kymasResult, mrmResult]),
      truncated: truncatedLabels([kymasResult, mrmResult])
    },
    kymas
  };
}

export default {
  collect,
  parseVersion,
  compareVersions,
  currencyOf,
  joinModules,
  BEHIND,
  CURRENT,
  AHEAD
};
