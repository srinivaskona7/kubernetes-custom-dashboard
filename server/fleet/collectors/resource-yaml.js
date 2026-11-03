/**
 * One live object, as YAML, for the detail drawers.
 *
 * ## What this is for
 *
 * Every other surface in this console reports *about* a resource — counts, conditions, derived
 * verdicts. None of them show the object. An operator looking at a Deployment in the Helm
 * Architecture graph and asking "but what does it actually say" had nowhere to go: the Manifest
 * tab shows what Helm *rendered*, which is not the running object once a webhook, an HPA or a
 * later edit has touched it. This is the running object.
 *
 * ## Read-only, and bounded on purpose
 *
 * - `GET` only, and only the Kinds in `LIVE_KINDS` (shared with `helm-related.js`, so the set of
 *   readable Kinds cannot drift from the set the graph draws). An arbitrary `kind` is refused
 *   before any call is made, so this route can never be walked into "fetch any object in the
 *   cluster".
 * - No new RBAC. `get` is already granted on every one of these Kinds; that was verified against
 *   the live role before this was written, and nothing here asks for a verb the reader lacks.
 *
 * ## Redaction — every rule below matches a rule this codebase already enforces elsewhere
 *
 * Nothing here is invented. A YAML view that showed more than the tab beside it would be a
 * widening of exposure dressed up as a convenience, so each redaction is the same call some
 * existing collector already made:
 *
 *  1. **`Secret.data` / `stringData` -> key names.** `helm-related.js` `factsFor`: *"Keys only.
 *     The contract in server/fleet is absolute: this file returns names, never values."*
 *  2. **`ConfigMap.data` / `binaryData` -> key names.** Same `factsFor`, same shape — a ConfigMap
 *     reports `{ keys: [...] }` and never its values. A ConfigMap is not a credential store by
 *     contract, but plenty of them hold one anyway, and this console is reachable by any
 *     authenticated user wherever `FLEET_REQUIRE_ADMIN_SCOPE` is off.
 *  3. **Container `env[].value` -> dropped, name kept.** `workloads.js` publishes
 *     `envKeys: c.env.map(e => e.name)` — names, never values — at two separate call sites.
 *  4. **`metadata.managedFields` -> dropped.** Not a secret, just the single largest and least
 *     readable part of most objects. `kubectl get -o yaml` hides it for the same reason.
 *  5. **`kubectl.kubernetes.io/last-applied-configuration` -> dropped.** This one is load-bearing:
 *     it is a complete JSON copy of the object as applied, sitting in an annotation, and it would
 *     carry the Secret values, ConfigMap values and env values that rules 1-3 just removed. Redact
 *     the object and leave this and the redaction has done nothing at all.
 *
 * What was removed is *reported* rather than silently done — `redactions` comes back with the
 * response and the drawer prints it. A blank field the reader believes is the configured value is
 * its own kind of wrong answer.
 */
import YAML from 'yaml';
import k8s from './../k8s.js';
import helmRelatedModule from './helm-related.js';
const { LIVE_KINDS } = helmRelatedModule;

/** The annotation that would undo every other redaction on this page. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/**
 * Kind -> the API paths that serve it, in declaration order.
 *
 * A list because `Certificate` is served by two different CRDs (Gardener and cert-manager) and a
 * cluster may have either, both or neither. The read tries each and takes the first that answers,
 * which is the same thing `helm-related.js` does when it lists them.
 */
function pathsFor(kind, namespace) {
  const segment = namespace ? `namespaces/${encodeURIComponent(namespace)}/` : '';
  return LIVE_KINDS.filter(k => k.kind === kind).map(k => {
    // `path` builds a *collection* URL and some carry a query string (`pods?limit=2000`) that
    // means nothing for a single object. Take the path, drop the query, append the name.
    const [collection] = k.path(segment).split('?');
    return collection;
  });
}

/** Every Kind this route will read. Exported so the router can answer 400 before any call. */
const READABLE_KINDS = [...new Set(LIVE_KINDS.map(k => k.kind))].sort();

/**
 * Strip `value` from a container's env, keeping the name and any `valueFrom` reference.
 *
 * `valueFrom` survives deliberately: it names a Secret key or a field path rather than carrying a
 * value, and it is exactly what an operator debugging "where does this variable come from" needs.
 */
function redactEnv(container, note) {
  if (!container || !Array.isArray(container.env)) return;
  let hit = false;
  container.env = container.env.map(e => {
    if (e && typeof e === 'object' && 'value' in e) {
      hit = true;
      const { value, ...rest } = e;
      return { ...rest };
    }
    return e;
  });
  if (hit) note('container env values (names kept)');
}

/** Every pod spec inside an object, at every nesting this console's Kinds actually use. */
function podSpecsIn(obj) {
  const specs = [];
  const spec = obj.spec || {};
  if (Array.isArray(spec.containers)) specs.push(spec); // Pod
  const template = spec.template && spec.template.spec;
  if (template) specs.push(template); // Deployment, StatefulSet, DaemonSet, ReplicaSet, Job
  const nested = spec.jobTemplate && spec.jobTemplate.spec && spec.jobTemplate.spec.template;
  if (nested && nested.spec) specs.push(nested.spec); // CronJob
  return specs;
}

/**
 * The object as it may leave the pod.
 *
 * Mutates a structuredClone, never the caller's object, and returns the list of what it took out
 * so the response can say so.
 */
function redact(object) {
  const obj = structuredClone(object);
  const removed = new Set();
  const note = what => removed.add(what);

  const metadata = obj.metadata || {};
  if (metadata.managedFields) {
    delete metadata.managedFields;
    note('metadata.managedFields');
  }
  if (metadata.annotations && LAST_APPLIED in metadata.annotations) {
    delete metadata.annotations[LAST_APPLIED];
    note(`the ${LAST_APPLIED} annotation (a full unredacted copy of this object)`);
  }

  if (obj.kind === 'Secret') {
    for (const field of ['data', 'stringData']) {
      if (obj[field]) {
        const keys = Object.keys(obj[field]).sort();
        obj[field] = keys.reduce((acc, k) => ({ ...acc, [k]: null }), {});
        note(`Secret ${field} values (${keys.length} key${keys.length === 1 ? '' : 's'} kept)`);
      }
    }
  }

  if (obj.kind === 'ConfigMap') {
    for (const field of ['data', 'binaryData']) {
      if (obj[field]) {
        const keys = Object.keys(obj[field]).sort();
        obj[field] = keys.reduce((acc, k) => ({ ...acc, [k]: null }), {});
        note(`ConfigMap ${field} values (${keys.length} key${keys.length === 1 ? '' : 's'} kept)`);
      }
    }
  }

  for (const podSpec of podSpecsIn(obj)) {
    for (const list of ['containers', 'initContainers', 'ephemeralContainers']) {
      for (const c of podSpec[list] || []) redactEnv(c, note);
    }
  }

  return { object: obj, redactions: [...removed] };
}

/**
 * Read one object and return it as YAML.
 *
 * Shaped as a collector so it rides the same fan-out, gate, priority and error typing as every
 * other read: a 404 comes back as a typed `NOT_FOUND` the router turns into a 404 (the object was
 * deleted since the graph was drawn), and a 403 stays a 403 rather than being reported as an
 * unreachable cluster.
 */
async function read({ cluster, token, kind, namespace, name, callFn = k8s.call, ...rest }) {
  const paths = pathsFor(kind, namespace);
  if (paths.length === 0) {
    const err = new Error(`${kind} is not a Kind this console reads`);
    err.code = 'UNSUPPORTED_KIND';
    err.status = 400;
    throw err;
  }

  let lastError = null;
  for (const base of paths) {
    try {
      const object = await callFn({
        ...rest,
        cluster,
        token,
        path: `${base}/${encodeURIComponent(name)}`
      });
      const { object: safe, redactions } = redact(object);
      return {
        kind,
        name,
        namespace: namespace || null,
        apiVersion: safe.apiVersion || null,
        resourceVersion: (safe.metadata && safe.metadata.resourceVersion) || null,
        yaml: YAML.stringify(safe, { lineWidth: 0 }),
        redactions
      };
    } catch (err) {
      // Only a 404 is worth trying the next path for — that is the Gardener/cert-manager case,
      // where one CRD is absent and the other holds the object. A 403 means the reader is not
      // allowed to see it, and asking a second API for the same object would turn one honest
      // permission error into a misleading "not found".
      if (err && err.status === 404) { lastError = err; continue; }
      throw err;
    }
  }
  throw lastError;
}

export default { read, redact, pathsFor, READABLE_KINDS, LAST_APPLIED };
