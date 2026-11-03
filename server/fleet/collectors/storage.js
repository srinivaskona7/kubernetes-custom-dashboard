/**
 * Storage and Resource Quota collector.
 *
 * Tracks PersistentVolumeClaims (status, requested storage, storage class),
 * namespace ResourceQuotas (CPU/Memory/Storage limits vs used), and LimitRanges.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import healthModule from './health.js';
const { parseMemory } = healthModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;

/**
 * The namespace path segment for a namespaced list, or '' for a cluster-wide one.
 *
 * `namespace` arrives straight off `?namespace=` and is interpolated into a URL that carries
 * the fleet service account's bearer token, so it is untrusted input to an API path. Left
 * unencoded, a value like `../../../apis/rbac.authorization.k8s.io/v1/clusterroles?x=`
 * survives the `new URL()` in k8s.js, which normalises the `..` segments away and re-points
 * the read at any list resource the account can reach on any registered cluster — with the
 * object names handed straight back to the caller. Encoding turns the separators into `%2F`,
 * which the URL parser does not collapse, so the path can no longer be steered.
 *
 * Encoding alone is not enough. `.` is an unreserved character, so `..` passes through
 * untouched and `new URL()` then folds `namespaces/../persistentvolumeclaims` down to the
 * cluster-wide `/api/v1/persistentvolumeclaims`. A dot-only segment is not a legal namespace
 * name, so it is refused rather than encoded. Both halves are load-bearing; neither is a
 * simplification waiting to happen. The same guard is in networking.js for the same reason.
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
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, namespace, listFn = list }) {
  const nsQuery = namespaceSegment(namespace);
  const baseCtx = { cluster, token };

  const [pvcResult, quotaResult, limitResult, storageClassResult, namespaceResult] = await Promise.all([
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}persistentvolumeclaims`, 'pvc'),
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}resourcequotas`, 'resourcequotas'),
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}limitranges`, 'limitranges'),
    // storage.k8s.io/storageclasses is cluster-scoped and already granted — no new RBAC.
    safeList(listFn, baseCtx, '/apis/storage.k8s.io/v1/storageclasses', 'storageclasses'),
    // Only needed for quotaCoverage's denominator, and only when the read is fleet-wide —
    // see the namespace-scoped guard below.
    namespace ? Promise.resolve(null) : safeList(listFn, baseCtx, '/api/v1/namespaces', 'namespaces')
  ]);
  const pvcs = pvcResult.items;
  const quotas = quotaResult.items;
  const limitranges = limitResult.items;
  const storageClasses = storageClassResult.items;

  let totalRequestedBytes = 0;
  const pvcItems = pvcs.map(p => {
    const spec = p.spec || {};
    const status = p.status || {};
    const reqStorage = (spec.resources && spec.resources.requests && spec.resources.requests.storage) || '0';
    /**
     * The bound volume's capacity, or `null` — never the request.
     *
     * This used to fall back to `reqStorage`, which made the two cases an operator most needs
     * separated identical on the wire: a claim whose provisioner rounded 10Gi up to 20Gi and
     * never reported it, and a claim honoured at exactly 10Gi. `status.capacity` is only
     * populated once the volume is bound, so an unbound or unreconciled claim has no capacity
     * to state and the UI renders "not reported" rather than echoing the ask back as an answer.
     *
     * Neither number is filesystem usage. Nothing on this path reads how full a volume is —
     * the API server cannot see it — which is why the column header carries the caveat.
     */
    const capStorage = (status.capacity && status.capacity.storage) || null;
    const reqBytes = parseMemory(reqStorage);
    totalRequestedBytes += reqBytes;

    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      status: status.phase || 'Unknown', // Bound, Pending, Lost
      /**
       * Absent is absent. Publishing the literal `'default'` here put a word in the
       * StorageClass column that no object in the cluster necessarily answers to — and it
       * collided with a StorageClass actually *named* `default`, which Gardener ships. `null`
       * means the claim names no class, and the UI says so in words.
       *
       * `''` is kept distinct from absent on purpose: an explicitly empty `storageClassName`
       * opts out of dynamic provisioning entirely, which is not the same as omitting it.
       */
      storageClass: spec.storageClassName == null ? null : spec.storageClassName,
      requested: reqStorage,
      requestedBytes: reqBytes,
      capacity: capStorage,
      /**
       * The same quantity in bytes, so the column can sort. `512Mi` sorts above `5Gi` as text and
       * below it as a quantity, and the string is the only thing the wire used to carry — an
       * absent capacity stays `null` here rather than becoming a sortable 0.
       */
      capacityBytes: capStorage == null ? null : parseMemory(capStorage),
      accessModes: spec.accessModes || [],
      volumeName: spec.volumeName || null,
      createdAt: p.metadata.creationTimestamp || null
    };
  });

  const quotaItems = quotas.map(q => {
    const spec = q.spec || {};
    const status = q.status || {};
    /**
     * `status.hard` and `spec.hard` are not the same fact, and collapsing them with `||` made
     * configured intent and enforced limit render identically.
     *
     * `spec.hard` is what an author asked for; `status.hard` is what the quota controller has
     * accepted and is now enforcing. A quota created seconds ago — or one the controller is not
     * reconciling at all — has the first and not the second, and an operator reading a row off
     * `spec.hard` believes a ceiling is in force that nothing is applying. So the source travels
     * with the numbers: `enforced` when it came from status, `configured` when only the spec had
     * it, `null` when neither did.
     */
    const enforced = status.hard && typeof status.hard === 'object' ? status.hard : null;
    const configured = spec.hard && typeof spec.hard === 'object' ? spec.hard : null;
    const hard = enforced || configured || {};
    const hardSource = enforced ? 'enforced' : configured ? 'configured' : null;
    /**
     * `used` absent is not `'0'`. A dimension the controller has not reconciled has no usage
     * figure at all, and `'0'` renders it as a completely idle namespace — the exact shape of
     * "a failed read shown as a confident zero". Likewise a dimension present in `used` but not
     * in `hard` is "this quota does not mention that resource", not `unlimited`; both stay
     * `null` and the UI names each state.
     */
    const used = status.used && typeof status.used === 'object' ? status.used : {};
    const usedReported = Boolean(status.used && typeof status.used === 'object');

    const dimensions = Object.keys({ ...hard, ...used }).map(dim => ({
      dimension: dim,
      hard: hard[dim] == null ? null : hard[dim],
      used: used[dim] == null ? null : used[dim]
    }));

    return {
      name: q.metadata.name,
      namespace: q.metadata.namespace,
      dimensions,
      hardSource,
      usedReported,
      createdAt: q.metadata.creationTimestamp || null
    };
  });

  const boundCount = pvcItems.filter(p => p.status === 'Bound').length;
  const pendingCount = pvcItems.filter(p => p.status === 'Pending').length;

  /**
   * The LimitRanges themselves, not just how many there are.
   *
   * This read already happened — `limitResult` above — and only its `.length` was ever
   * published, so an operator could learn that three LimitRanges exist but never which
   * defaults they impose. The defaults are the whole operational content: a container that
   * declares no limit silently inherits `default`, which is exactly the case
   * `capacity.js`'s `limitSumIsFloor` warns about. Adding the list costs no new API call.
   *
   * `null` rather than `{}` for an absent block: a LimitRange with no `default` is different
   * from one defaulting to nothing, and `{}` reads as the latter.
   */
  const limitRangeItems = limitranges.map(lr => ({
    name: lr.metadata.name,
    namespace: lr.metadata.namespace,
    limits: ((lr.spec && lr.spec.limits) || []).map(l => ({
      type: l.type || 'Container',
      default: l.default || null,
      defaultRequest: l.defaultRequest || null,
      max: l.max || null,
      min: l.min || null
    })),
    createdAt: lr.metadata.creationTimestamp || null
  }));

  // Does a default StorageClass exist, is exactly one marked default, is it Ready? A
  // StorageClass has no status/conditions of its own — Ready here means "the object we'd
  // actually hand out exists at all"; there is nothing further to be Ready or not on it.
  const defaultClasses = storageClasses.filter(
    sc => (sc.metadata && sc.metadata.annotations && sc.metadata.annotations['storageclass.kubernetes.io/is-default-class']) === 'true'
  );
  const defaultStorageClassState = storageClassResult.unavailable
    ? { state: 'unavailable', name: null, detail: storageClassResult.detail }
    : defaultClasses.length === 0
      ? { state: 'missing', name: null, detail: 'no StorageClass is marked default' }
      : defaultClasses.length > 1
        ? { state: 'ambiguous', name: defaultClasses.map(sc => sc.metadata.name), detail: `${defaultClasses.length} StorageClasses are marked default` }
        : { state: 'ready', name: defaultClasses[0].metadata.name, detail: null };

  // A fleet-wide ratio is meaningless scoped to one namespace — a single namespace's
  // "1 of 1 has a quota" or "0 of 1" would otherwise masquerade as a fleet statistic.
  // Also null whenever either side of the ratio could not be read.
  const quotaCoverage = namespace || !namespaceResult || namespaceResult.unavailable || quotaResult.unavailable
    ? null
    : (namespaceResult.items.length === 0
      ? null
      : new Set(quotaItems.map(q => q.namespace)).size / namespaceResult.items.length);

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      totalPvcs: pvcItems.length,
      boundPvcs: boundCount,
      pendingPvcs: pendingCount,
      totalRequestedBytes,
      quotasCount: quotaItems.length,
      limitRangesCount: limitranges.length,
      defaultStorageClassState,
      quotaCoverage,
      unavailable: unavailableLabels([pvcResult, quotaResult, limitResult, storageClassResult, namespaceResult].filter(Boolean)),
      // Reads that answered but stopped at the client's paging ceiling. `totalRequestedBytes`
      // is the one that hides it best: a partial sum is still a plausible-looking capacity
      // figure, where a partial count at least sits next to a list an operator can scroll.
      truncated: truncatedLabels([pvcResult, quotaResult, limitResult, storageClassResult, namespaceResult].filter(Boolean))
    },
    pvcs: pvcItems,
    quotas: quotaItems,
    limitRanges: limitRangeItems,
    collectedAt: new Date().toISOString()
  };
}

export default { collect };
