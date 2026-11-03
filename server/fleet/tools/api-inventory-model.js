/**
 * The pure half of the API inventory: discovery normalisation, domain grouping, count
 * arithmetic and the value-free field digest.
 *
 * It is separated from `api-inventory.js` because every rule in here is a judgement that
 * shapes the dashboard's layout — which Kinds sit in which panel, what a "count" means when
 * the server only sent one page, which object paths are safe to write into a committed
 * document — and a judgement nobody can run without a live cluster is a judgement nobody
 * reviews. Nothing here opens a socket.
 *
 * Two invariants hold across the whole file and are each covered by a test:
 *
 *  1. **No value ever leaves an object.** `fieldDigest` records paths and JSON types.
 *     A cluster's objects carry connection strings in a CRD spec, e-mail addresses in an
 *     annotation and base64 in a ConfigMap, and this output is a file that gets committed.
 *  2. **A count that could not be read is `null`, never `0`.** The console's whole
 *     completeness contract rests on that distinction, and a generated document that
 *     flattens a 403 into "0 objects" would be the most convincing wrong thing in the repo.
 */

/* ------------------------------------------------------------------ discovery shapes */

/**
 * Normalise the two discovery responses into one flat list of resource entries.
 *
 * Aggregated discovery (KEP-3352, `Accept: application/json;g=apidiscovery.k8s.io;v=v2;
 * as=APIGroupDiscoveryList`) answers with every group, version, resource, scope, verb and
 * subresource in a single request. A server that does not implement it **ignores the
 * header rather than failing**, so the caller detects by `kind`, not by status, and hands
 * us the legacy `APIResourceList` per group instead. Both land here.
 *
 * The first version listed for a group is its preferred one — aggregated discovery orders
 * `versions[]` by priority, the same order `APIGroup.preferredVersion` reports. Marking it
 * matters because a dashboard that offers `v1alpha1` alongside `v1` for the same Kind
 * shows the operator two doors into one room.
 *
 * @param {object} doc an APIGroupDiscoveryList
 * @returns {ResourceEntry[]}
 */
function fromAggregated(doc) {
  const out = [];
  for (const group of doc.items || []) {
    const groupName = (group.metadata && group.metadata.name) || '';
    (group.versions || []).forEach((version, versionIndex) => {
      for (const r of version.resources || []) {
        out.push(entry({
          group: groupName,
          version: version.version,
          preferred: versionIndex === 0,
          resource: r.resource,
          kind: (r.responseKind && r.responseKind.kind) || null,
          scope: r.scope === 'Namespaced' ? 'Namespaced' : 'Cluster',
          singular: r.singularResource || null,
          verbs: r.verbs || [],
          shortNames: r.shortNames || [],
          categories: r.categories || [],
          subresources: (r.subresources || []).map(s => ({
            name: s.subresource,
            kind: (s.responseKind && s.responseKind.kind) || null,
            verbs: s.verbs || []
          }))
        }));
      }
    });
  }
  return out;
}

/**
 * The fallback: one legacy `APIResourceList` for one group/version.
 *
 * The legacy shape flattens subresources into the same array as their parents, spelled
 * `pods/log`, and gives no `scope` field — only `namespaced`. Both are repaired here so a
 * caller downstream never has to know which discovery answered.
 *
 * @param {object} doc an APIResourceList
 * @param {string} group '' for the core group
 * @param {string} version
 * @param {boolean} preferred
 * @returns {ResourceEntry[]}
 */
function fromLegacy(doc, { group, version, preferred }) {
  const parents = new Map();
  const children = [];
  for (const r of doc.resources || []) {
    if (r.name.includes('/')) { children.push(r); continue; }
    parents.set(r.name, entry({
      group, version, preferred,
      resource: r.name,
      kind: r.kind || null,
      scope: r.namespaced ? 'Namespaced' : 'Cluster',
      singular: r.singularName || null,
      verbs: r.verbs || [],
      shortNames: r.shortNames || [],
      categories: r.categories || [],
      subresources: []
    }));
  }
  for (const c of children) {
    const [parentName, ...rest] = c.name.split('/');
    const parent = parents.get(parentName);
    // A subresource whose parent is not in the same list is not a thing the API server
    // emits; dropping it silently would hide a real discovery anomaly, so it becomes a
    // top-level entry and shows up as such in the document.
    if (!parent) continue;
    parent.subresources.push({ name: rest.join('/'), kind: c.kind || null, verbs: c.verbs || [] });
  }
  return [...parents.values()];
}

/** One resource entry, with the derived fields every consumer needs. */
function entry(fields) {
  const { group, version, resource, scope, verbs } = fields;
  const apiVersion = group ? `${group}/${version}` : version;
  const base = group ? `/apis/${group}/${version}` : `/api/${version}`;
  return {
    ...fields,
    apiVersion,
    /** Cluster-wide collection path. Namespaced types also answer here, across namespaces. */
    listPath: `${base}/${resource}`,
    /** The same read scoped to one namespace, or null for a cluster-scoped type. */
    namespacedListPath: scope === 'Namespaced' ? `${base}/namespaces/{namespace}/${resource}` : null,
    listable: (verbs || []).includes('list'),
    watchable: (verbs || []).includes('watch'),
    kubectl: kubectlFor({ resource, group, scope })
  };
}

/**
 * The `kubectl get` line for this resource.
 *
 * Fully qualified (`resource.group`) rather than the short name, because two groups can and
 * do own the same plural — `gateways` exists in both `networking.istio.io` and
 * `gateway.networking.k8s.io` on a Kyma cluster, and a document that printed `kubectl get
 * gateways` would be printing an ambiguity.
 */
function kubectlFor({ resource, group, scope }) {
  const name = group ? `${resource}.${group}` : resource;
  return scope === 'Namespaced' ? `kubectl get ${name} -A` : `kubectl get ${name}`;
}

/* --------------------------------------------------------------------- count reading */

/**
 * The exact live object count from a one-item page.
 *
 * `?limit=1` plus `metadata.remainingItemCount` is the cheapest exact count the API server
 * offers: it returns one object and a number, instead of the whole collection. Two traps
 * come with it, and both have cost time here before:
 *
 *  - It must be a **plain GET**, not the dashboard's `list()` helper. `list()` sends
 *    `resourceVersion=0` to hit the watch cache, the watch cache does not paginate, and so
 *    the server ignores `limit` and returns everything. Correct, but not cheap, and with no
 *    `remainingItemCount` to read.
 *  - `remainingItemCount` is **absent, not zero**, on a final page. Reading it as a number
 *    without the `|| 0` turns every collection that fits in one page into `NaN`.
 *
 * An empty collection is a true `0`: the server answered, and it said nothing is there.
 *
 * @param {object} page a List response
 * @returns {number}
 */
function countFromPage(page) {
  const items = Array.isArray(page && page.items) ? page.items.length : 0;
  const remaining = page && page.metadata && page.metadata.remainingItemCount;
  return items + (typeof remaining === 'number' ? remaining : 0);
}

/* ----------------------------------------------------------------- the field digest */

/**
 * Keys whose *names* are chosen by whoever wrote the object, not by a schema.
 *
 * Descending into these would put user-authored strings into the document — a ConfigMap's
 * data keys, an annotation naming an internal hostname, a label carrying a cost-centre
 * code. The shape is recorded as a map and the walk stops. `managedFields` is excluded for
 * a duller reason: it is an unbounded mirror of every field any controller ever set, and
 * it would dominate the digest of every single Kind.
 */
const OPAQUE_KEYS = new Set([
  'data', 'stringData', 'binaryData', 'annotations', 'labels', 'matchLabels',
  'nodeSelector', 'selector', 'limits', 'requests', 'capacity', 'allocatable'
]);
const SKIP_KEYS = new Set(['managedFields']);

/**
 * Kinds that are never sampled, only counted.
 *
 * A Secret's *field paths* are harmless, but reading one to learn them pulls the whole
 * decoded payload through this process and into whatever log the run writes. The rule
 * elsewhere in this codebase is that the backend returns Secret keys and never Secret
 * values; the rule here is stricter and simpler — do not fetch the object at all. Nothing
 * about a Secret's shape is in doubt.
 */
const NEVER_SAMPLE = new Set(['Secret', 'TokenRequest', 'TokenReview', 'SelfSubjectReview']);

/**
 * Walk one object and return `[{ path, type }]` — paths and JSON types, no values.
 *
 * Arrays collapse to their first element with a `[]` marker on the path, because a
 * dashboard needs to know that `spec.containers[]` exists and carries an `image`, not that
 * this particular Pod happened to have two of them.
 *
 * @param {object} obj a single API object
 * @param {object} [opts]
 * @param {number} [opts.maxDepth] how deep to walk; 6 covers `status.conditions[].type`
 * @param {number} [opts.maxPaths] ceiling, so one pathological CRD cannot dominate the file
 * @param {Set<string>} [opts.opaque] which key names to record without entering. Defaults to
 *   `OPAQUE_KEYS`, which is right for raw Kubernetes objects. A caller digesting *this
 *   backend's own* responses passes a narrower set: `limits`, `requests` and `capacity` are
 *   schema-named there (`capacity.cpuAllocatable`), while `labels` and `data` are still keyed
 *   by whoever wrote the object and must stay closed.
 * @returns {{path: string, type: string}[]} sorted by path
 */
function fieldDigest(obj, { maxDepth = 6, maxPaths = 400, opaque = OPAQUE_KEYS } = {}) {
  const found = new Map();

  const typeOf = v => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  };

  const walk = (value, path, depth) => {
    if (found.size >= maxPaths) return;
    if (depth > maxDepth) return;
    if (value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      if (!value.length) return;
      const first = value[0];
      if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        walk(first, path, depth);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (SKIP_KEYS.has(key)) continue;
      const isArray = Array.isArray(child);
      const here = path ? `${path}.${key}${isArray ? '[]' : ''}` : `${key}${isArray ? '[]' : ''}`;
      if (found.size >= maxPaths) return;

      if (opaque.has(key)) {
        // Recorded, not entered. The consumer learns the field exists and what it holds.
        found.set(here, isArray ? 'array' : 'map');
        continue;
      }

      found.set(here, isArray ? arrayTypeOf(child) : typeOf(child));
      walk(child, here, depth + 1);
    }
  };

  const arrayTypeOf = arr => {
    if (!arr.length) return 'array(empty)';
    const t = typeOf(arr[0]);
    return t === 'object' ? 'array(object)' : `array(${t})`;
  };

  walk(obj, '', 1);
  return [...found.entries()]
    .map(([path, type]) => ({ path, type }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/* --------------------------------------------------------------- dashboard grouping */

/**
 * Which panel a Kind belongs in.
 *
 * The list is matched **in order** and every rule keys off the API group, never off a
 * cluster's object names — the point of this tool is that it produces the same domains on
 * a bare kubeadm cluster, a Kyma runtime and an OpenShift cluster, and a rule like "if it
 * is called istio-system" would only ever be right here.
 *
 * `test` is an exact group name, a suffix (`.kyma-project.io`) or a RegExp.
 */
const DOMAIN_RULES = [
  // `policy` holds PodDisruptionBudget, which is a workload-availability control and has
  // nothing to do with admission policy — filing it next to Gatekeeper constraints would
  // put the two most different meanings of the word "policy" in one panel.
  { domain: 'Workloads', test: ['', 'apps', 'batch', 'policy', /^autoscaling(\.k8s\.io)?$/, /(^|\.)keda\.sh$/] },
  { domain: 'Networking', test: [/(^|\.)networking\.k8s\.io$/, 'discovery.k8s.io', 'gateway.networking.k8s.io', /\.projectcalico\.org$/, /(^|\.)cilium\.io$/] },
  { domain: 'Service mesh', test: [/\.istio\.io$/, 'install.istio.io'] },
  { domain: 'Storage', test: ['storage.k8s.io', 'snapshot.storage.k8s.io'] },
  { domain: 'Identity & access', test: ['rbac.authorization.k8s.io', 'authentication.k8s.io', 'authorization.k8s.io', 'certificates.k8s.io', /\.ory\.sh$/] },
  { domain: 'Policy & admission', test: ['admissionregistration.k8s.io', /gatekeeper\.sh$/, /^kyverno\.io$/] },
  { domain: 'Observability', test: ['metrics.k8s.io', /^monitoring\./, /^opentelemetry\.io$/, 'telemetry.kyma-project.io', /^logging\./, /^dynatrace\.com$/] },
  { domain: 'Certificates & DNS', test: [/^cert\./, /^dns\./, 'cert-manager.io', 'acme.cert-manager.io'] },
  { domain: 'Cluster & scheduling', test: ['node.k8s.io', 'scheduling.k8s.io', 'coordination.k8s.io', 'events.k8s.io', 'flowcontrol.apiserver.k8s.io', 'resource.k8s.io'] },
  { domain: 'API extension', test: ['apiextensions.k8s.io', 'apiregistration.k8s.io'] },
  { domain: 'Platform (Kyma)', test: [/\.kyma-project\.io$/] },
  { domain: 'SAP BTP', test: [/\.sap\.com$/] },
  { domain: 'Infrastructure (Gardener)', test: [/\.gardener\.cloud$/] }
];

/**
 * @param {string} group the API group, '' for core
 * @returns {string} a stable domain label
 */
function domainOf(group) {
  for (const rule of DOMAIN_RULES) {
    for (const t of rule.test) {
      if (t instanceof RegExp ? t.test(group) : t === group) return rule.domain;
    }
  }
  // Unmatched groups are bucketed by their registrable domain, so an operator nobody
  // anticipated still lands in one coherent section instead of a flat "Other" of forty
  // unrelated Kinds. `foo.bar.example.com` -> `example.com`.
  const parts = group.split('.');
  const suffix = parts.length >= 2 ? parts.slice(-2).join('.') : group;
  return suffix ? `Extensions: ${suffix}` : 'Other';
}

/**
 * Group entries into the sections a dashboard would render, ordered so that the domains an
 * operator opens first come first, and every unanticipated domain follows alphabetically.
 *
 * @param {ResourceEntry[]} entries
 * @returns {{domain: string, resources: ResourceEntry[]}[]}
 */
function byDomain(entries) {
  const buckets = new Map();
  for (const e of entries) {
    const domain = domainOf(e.group);
    if (!buckets.has(domain)) buckets.set(domain, []);
    buckets.get(domain).push(e);
  }
  const order = DOMAIN_RULES.map(r => r.domain);
  const rank = d => {
    const i = order.indexOf(d);
    return i === -1 ? order.length : i;
  };
  return [...buckets.entries()]
    .map(([domain, resources]) => ({
      domain,
      resources: resources.sort((a, b) => (a.kind || a.resource).localeCompare(b.kind || b.resource))
    }))
    .sort((a, b) => (rank(a.domain) - rank(b.domain)) || a.domain.localeCompare(b.domain));
}

/* ------------------------------------------------------------------------ reporting */

/**
 * The counts that head the document.
 *
 * `readable` and `refused` are deliberately not complements of each other: a probe can also
 * come back `unreachable` or `error`, and folding those into "refused" would tell a reader
 * that RBAC is the problem when the API server is.
 *
 * @param {ResourceEntry[]} entries entries carrying a `probe`
 */
function summarise(entries) {
  const probed = entries.filter(e => e.probe);
  const withCount = probed.filter(e => typeof e.probe.count === 'number');
  return {
    resources: entries.length,
    listable: entries.filter(e => e.listable).length,
    namespaced: entries.filter(e => e.scope === 'Namespaced').length,
    clusterScoped: entries.filter(e => e.scope === 'Cluster').length,
    subresources: entries.reduce((n, e) => n + e.subresources.length, 0),
    groups: new Set(entries.map(e => e.group)).size,
    probed: probed.length,
    readable: withCount.length,
    refused: probed.filter(e => e.probe.outcome === 'forbidden').length,
    failed: probed.filter(e => e.probe.outcome === 'error' || e.probe.outcome === 'unreachable').length,
    nonEmpty: withCount.filter(e => e.probe.count > 0).length,
    objects: withCount.reduce((n, e) => n + e.probe.count, 0)
  };
}

export default {
  fromAggregated, fromLegacy, entry, kubectlFor,
  countFromPage, fieldDigest, domainOf, byDomain, summarise,
  OPAQUE_KEYS, NEVER_SAMPLE, DOMAIN_RULES
};
