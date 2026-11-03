/**
 * Helm releases: chart version, merged values, revision history, and the resources each
 * release owns.
 *
 * Helm 3 keeps release state in a Secret per revision, named `sh.helm.release.v1.<name>.v<n>`
 * and labelled `owner=helm`. `.data.release` is base64 (the Secret encoding) wrapping base64
 * (Helm's own) wrapping gzip wrapping JSON.
 *
 * The one hard constraint this file is built around: **read releases with a LIST, never a
 * GET-by-name.** Verified live on 2026-09-10 by impersonating the reader service account —
 * `kubectl get secrets -l owner=helm` succeeds and returns full objects including
 * `.data.release`, while `kubectl get secret <name>` is refused whenever the role grants
 * `list` without `get`. The role currently grants both, but routing through LIST keeps this
 * collector working on the narrower grant too, so tightening Secrets back to list-only later
 * does not silently break the Helm tab.
 *
 * `helm get values --all` is reproduced as a deep merge of `chart.values` (the chart's own
 * defaults) under `config` (only what the operator overrode). Both halves are returned
 * separately as well, because "which of these did a human actually set" is usually the
 * question being asked.
 *
 * The rendered manifest is deliberately NOT part of `collect()`. It is tens of kilobytes of
 * YAML per release — measured live at 915 kB across 55 revisions on one cluster — so folding
 * it into the list response would put the whole lot on the wire every time the Helm tab
 * opens. It is served instead by `manifest()` below: one release, on request, redacted.
 */
import zlib from 'node:zlib';
import k8sModule from '../k8s.js';
const { list, METADATA_ONLY } = k8sModule;
import cap from '../capability.js';
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;
import errorsModule from '../errors.js';
const { ClusterError, NOT_FOUND } = errorsModule;
import workloads from './workloads.js';

const HELM_SECRET_TYPE = 'helm.sh/release.v1';

/**
 * Value keys whose content is a credential, matched case-insensitively anywhere in the key.
 *
 * A Helm release Secret's `config` is whatever an operator passed with `-f`/`--set`, and on a
 * real chart that regularly includes a database password, a client secret, or a PEM key. This
 * collector returns those values to a browser, which would make it the one place in this
 * codebase that hands out decoded Secret contents — every other Secret read here reports
 * `Object.keys(secret.data)` and stops (see collectors/compliance.js), and safe-list.js
 * redacts credentials out of even error strings.
 *
 * So the values viewer keeps the whole structure and every key, and masks only the leaves
 * that name themselves as secret. That preserves what the screen is actually for — replica
 * counts, image tags, hostnames, feature flags — without turning it into a credential dump
 * for anyone who can reach the dashboard.
 */
const SENSITIVE_SUBSTRING = /pass(word|phrase|wd)?|secret|token|credential|apikey|privatekey|keystore|truststore|certificate|connectionstring|clientsecret|signature|dockerconfigjson|kubeconfig|htpasswd|mnemonic/i;

/**
 * Words that are only a credential when they stand alone as a word in the key. Substring
 * matching on these over-masks badly: `key` would redact `keyspace` and `monkey`, and `cert`
 * would redact `certManagerEnabled`.
 */
/**
 * Keys whose subtree is a POINTER to a credential rather than the credential itself. Their
 * children must stay readable even though the key names a secret: `secretKeyRef: {name: creds,
 * key: cs}` tells an operator which Secret to go and look in, and masking that hides the one
 * thing the row is for while protecting nothing — the value is not here.
 *
 * They exist because sensitivity is inherited downward. Without a reset, `secretKeyRef`
 * matching the `secret` substring would redact the pointer it is supposed to publish.
 */
const REFERENCE_KEYS = /^(secret|configmap)(key)?ref$|^valuefrom$/i;

/**
 * Keys whose subtree DESCRIBES credential handling rather than holding a credential.
 *
 * Sensitivity inherits downward, so a section named after credentials blankets everything under
 * it. That is right for `secrets:` and wrong for a policy. Measured on a live release
 * 2026-09-16: the SAP BTP service operator's
 * `bindings.defaultProperties.credentialsRotationPolicy` turned `rotationFrequency: 24h` and
 * `rotatedBindingTTL: 48h` into `[redacted]`, and `bindings.auth` blanked
 * `serviceInstanceName`. None of the three is a credential, and the rotation settings are
 * exactly what an operator opens the page to check.
 *
 * Resetting inheritance here is safe because every leaf is still judged on its own key: a
 * `password` inside a `*Policy` subtree still masks. It applies only where the key names a
 * SUBTREE, so a scalar `auth: dXNlcjpwdw==` still masks on its own word.
 */
const DESCRIBES_CREDENTIALS = /policy$|^auth$/i;

const SENSITIVE_WORDS = new Set(['key', 'keys', 'cert', 'certs', 'pem', 'dsn', 'auth', 'authorization', 'basic', 'salt', 'passwd', 'pwd', 'pw', 'jwt', 'bearer', 'seed', 'webhook', 'jaas']);

/**
 * Keys whose VALUE is the NAME of a key rather than key material.
 *
 * `key`/`keys` earns its place in SENSITIVE_WORDS because a bare `key:` in a chart is usually a
 * PEM blob. But Kubernetes spells several label-selector fields with that suffix, and a chart
 * passing them through gets an operator's scheduling configuration blanked: measured live
 * 2026-09-16, `topologySpreadConstraints[].topologyKey` and `.matchLabelKeys[]` both read
 * `[redacted]` where the real values were `topology.kubernetes.io/zone` and `pod-template-hash`.
 * Neither is a credential; both are what the constraint is FOR.
 *
 * Enumerated rather than inferred, and compared against the whole normalised key. A rule like
 * "`key` preceded by any word is a name" would unmask `signingKey` and `privateKey`, so every
 * entry here is a field name Kubernetes or a broadly used chart defines, a bare `key` still
 * masks, and nothing generalises past the list.
 */
const KEY_NAME_FIELDS = new Set([
  'topologykey', // pod topology spread and affinity
  'matchlabelkeys',
  'mismatchlabelkeys',
  'labelkey',
  'labelkeys',
  'annotationkey',
  'annotationkeys',
  'nodeselectorkey',
  'partitionkey', // stream and queue routing
  'routingkey'
]);

/**
 * Credentials that a key-shaped rule cannot catch, recognised by the SHAPE OF THE VALUE.
 *
 * The key vocabulary above only works when whoever wrote the values file named the key after
 * what it holds. Real charts routinely do not: `env.DATABASE_URL` holds
 * `postgres://user:pw@host/db`, `sasl.jaas.config` holds an inline `password="…"`, a chart's
 * `repository` can carry `https://user:pw@repo`, and a PEM private key or a kubeconfig blob can
 * sit under any key at all. So there are two passes, not one — the same belt-and-braces
 * `safe-list.js`'s `redact()` applies to error strings.
 *
 * Where the credential is only PART of the value, only that part is replaced: a database URL
 * keeps its host and database name, because "which host does this point at" is exactly the
 * question the values screen exists to answer.
 */
const WHOLE_VALUE_CREDENTIAL = [
  /-----BEGIN [A-Z][A-Z ]*-----/,           // PEM: private key, certificate, or PKCS bundle
  /"auths"\s*:/,                            // a .dockerconfigjson registry auth blob
  /client-key-data\s*:|client-certificate-data\s*:/, // an embedded kubeconfig
  /hooks\.slack\.com\/services\//,          // a webhook URL IS the credential
  /discord(?:app)?\.com\/api\/webhooks\//,
  /webhook\.office\.com\/webhookb2\//
];

/**
 * Replace the credential inside an otherwise-informative string, keeping the rest readable.
 *
 * **Every quantifier here is bounded, and that is load-bearing.** Unbounded runs like
 * `[^/\s@]+@` backtrack from each starting offset, which makes the scan quadratic in the
 * length of the value. Measured 2026-09-16: 16 kB took 209 ms, so a 512 kB scalar — one
 * base64 blob in a ConfigMap, which `kubectl create configmap --from-file` produces as a
 * matter of course — pinned the event loop for minutes on a single-replica pod. The bounds
 * cost nothing in coverage: no real credential has 256 characters of userinfo.
 */
function scrubValue(text) {
  return text
    // JWTs first, so `Bearer eyJ…` loses the token before the header rule generalises it.
    .replace(/eyJ[A-Za-z0-9_-]{4,2048}(?:\.[A-Za-z0-9_-]{1,2048}){1,3}/g, MASKED)
    .replace(/\b(bearer)\s+\S{1,4096}/gi, `$1 ${MASKED}`)
    // scheme://user:pw@host -> scheme://[redacted]@host. The host survives on purpose.
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]{0,32}:\/\/)[^/\s@]{1,256}@/g, `$1${MASKED}@`)
    // An inline assignment, as in a JAAS config or an ODBC connection string.
    .replace(
      /\b((?:access[_-]|id[_-]|refresh[_-])?token|api[_-]?key|secret|password|passwd|pwd|authorization)(["']?\s*[:=]\s*["']?)[^\s,;"'&})\]]{1,1024}/gi,
      `$1$2${MASKED}`
    );
}

/**
 * Past this, a scalar is a blob rather than a value a human wrote, and scanning it is all
 * cost. The cheap whole-value check still runs — a PEM key or a kubeconfig is caught by a
 * literal match with no backtracking — but the substring scrubbers are skipped.
 */
const MAX_SCRUB_BYTES = 32 * 1024;

/**
 * A string value that carries a credential regardless of the key above it.
 * Returns the safe form, or the string unchanged when there is nothing to redact.
 */
function safeString(text) {
  if (WHOLE_VALUE_CREDENTIAL.some(re => re.test(text))) return MASKED;
  if (text.length > MAX_SCRUB_BYTES) return text;
  return scrubValue(text);
}

/**
 * Split a values key into words, so `clientSecret`, `client_secret`, `CLIENT-SECRET` and
 * `signingKey` all decompose the same way. camelCase boundaries matter here: `signingKey` has
 * to yield `key`, while `monkey` must not.
 */
function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean);
}

function isSensitiveKey(key) {
  if (KEY_NAME_FIELDS.has(keyWords(key).join(''))) return false;
  if (SENSITIVE_SUBSTRING.test(key)) return true;
  return keyWords(key).some(w => SENSITIVE_WORDS.has(w));
}

/** What a masked leaf is replaced with. Says the key is set without saying what it is set to. */
const MASKED = '[redacted]';

/**
 * Walk a values tree and mask every leaf under a credential-shaped key.
 *
 * Structure-preserving on purpose: an operator needs to see that `xsuaa.clientsecret` IS set
 * (a missing one is a real finding) without being shown it. Arrays keep their length for the
 * same reason.
 *
 * The `{name, value}` case is handled specially, because it is the one place where the key
 * naming the credential is not the key holding it. Charts overwhelmingly expose extra
 * environment as `extraEnv: [{name: DB_PASSWORD, value: "hunter2"}]`, and neither `name` nor
 * `value` is credential-shaped, so a purely key-driven walk hands `hunter2` to the browser.
 * When an object carries a `name`/`value` string pair, the NAME decides whether the VALUE is
 * masked — the same rule `envKeys` applies to a pod spec, expressed for values.
 */
function maskValues(value, keyIsSensitive = false) {
  if (Array.isArray(value)) return value.map(v => maskValues(v, keyIsSensitive));
  if (isPlainObject(value)) {
    const envShaped =
      typeof value.name === 'string' && Object.prototype.hasOwnProperty.call(value, 'value') && isSensitiveKey(value.name);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // `keyIsSensitive` carries down. Without it the flag propagated into arrays but died at
      // every object boundary, so a leaf one level under a credential-named parent was judged
      // on its own key alone — `apiKeys.mobile` and `secrets.db.password` both reached the
      // browser in cleartext. Inheriting errs toward over-masking under a parent that named
      // itself a credential, which is the right side to err on: the key stays visible, so the
      // operator still sees that the value is set. A reference key resets it, because its
      // subtree names where the credential lives rather than holding it.
      //
      // Three resets, each of which only clears what was INHERITED — the child's own key is
      // still judged, so nothing that names itself a credential survives any of them:
      //
      //  - a reference key, whose subtree names where the credential lives;
      //  - a subtree that describes credential handling (`*Policy`, an `auth:` section);
      //  - a `name` leaf, which points AT an object rather than holding its content. This is the
      //    Kubernetes idiom — `imagePullSecret.name`, `existingSecret.name`, `secretRef.name` —
      //    and `secretKeyRef.name` was already exempt for exactly this reason. It follows the
      //    convention the rest of server/fleet holds to: names and keys are published, values are
      //    not. The cost is that a `name` used as a username under a `secrets:` section reads in
      //    the clear; the benefit is that the Secret an operator has to go and look in is
      //    nameable, which is the whole point of the row.
      const describesRatherThanHolds = DESCRIBES_CREDENTIALS.test(k) && (isPlainObject(v) || Array.isArray(v));
      const pointsAtAnObject = k === 'name' && typeof v === 'string';
      out[k] =
        REFERENCE_KEYS.test(k) || describesRatherThanHolds || pointsAtAnObject
          ? maskValues(v, false)
          : maskValues(v, keyIsSensitive || isSensitiveKey(k) || (envShaped && k === 'value'));
    }
    return out;
  }
  // Only non-empty scalars are masked: `null` and `''` mean "not set", which is information
  // the operator needs and which reveals nothing.
  if (value === null || value === undefined || value === '') return value;
  // A credential is never a boolean or a number. This is what keeps `certManagerEnabled: true`
  // and `tls.keyLength: 4096` readable while `tls.key` is masked — the key-word check alone
  // cannot tell a switch that mentions a credential from the credential itself.
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (keyIsSensitive) return MASKED;
  // The key said nothing, so fall back to the shape of the value itself.
  return typeof value === 'string' ? safeString(value) : value;
}

/**
 * Deep-merge Helm values the way Helm itself does: maps merge key-by-key, and any non-map
 * (including arrays and null) replaces wholesale rather than being combined element-wise.
 */
function mergeValues(defaults, overrides) {
  if (!isPlainObject(defaults) || !isPlainObject(overrides)) {
    return overrides === undefined ? defaults : overrides;
  }
  const out = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = key in defaults ? mergeValues(defaults[key], value) : value;
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * base64 -> base64 -> gzip -> JSON, with each of the last three layers optional.
 *
 * Two candidates are tried in order, because base64 decoding never fails loudly: feeding it
 * raw JSON returns confident garbage rather than throwing, so "did the inner decode work"
 * can only be answered by trying to parse the result. Helm's own double-encoded form is
 * tried first; a hand-written Secret that skipped that layer falls through to the second.
 *
 * Returns null rather than throwing — one undecodable release must not take down the list.
 */
function decodeRelease(encoded) {
  const once = (() => {
    try {
      return Buffer.from(encoded, 'base64');
    } catch {
      return null;
    }
  })();
  if (!once || once.length === 0) return null;

  const candidates = [Buffer.from(once.toString('utf8'), 'base64'), once];
  for (const candidate of candidates) {
    if (!candidate || candidate.length === 0) continue;
    const parsed = parsePayload(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * A release payload that decompresses past this is not a release we can usefully show, and
 * inflating it would be the whole pod's memory budget (`chart/values.yaml` caps `srv` at
 * 500M) spent on one Secret. `gunzipSync` allocates the entire output in one go, so without
 * a ceiling a single malformed or hostile release secret decides whether the process lives.
 * Past the limit zlib throws, `parsePayload` returns null, and the release is reported
 * undecodable — the same outcome as any other corrupt payload, which callers already handle.
 */
const MAX_RELEASE_BYTES = 16 * 1024 * 1024;

/** Gunzip if it is gzipped, then JSON.parse. Null on any failure. */
function parsePayload(buffer) {
  try {
    const gzipped = buffer[0] === 0x1f && buffer[1] === 0x8b;
    const raw = gzipped ? zlib.gunzipSync(buffer, { maxOutputLength: MAX_RELEASE_BYTES }) : buffer;
    const parsed = JSON.parse(raw.toString('utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Count and name the resources a release rendered, from its manifest YAML.
 *
 * This is a deliberate line-scanner rather than a YAML parse: the manifest is a multi-document
 * stream whose only load-bearing fields here are top-level `kind:` and the `name:` directly
 * under `metadata:`. Pulling in a YAML parser to read two keys would also mean parsing every
 * value in the manifest, which is exactly the content this collector avoids handling.
 */
function parseManifest(manifest) {
  if (typeof manifest !== 'string' || manifest.length === 0) {
    return { kinds: {}, resources: [] };
  }
  const kinds = {};
  const resources = [];
  let kind = null;
  let name = null;
  let namespace = null;
  let inMetadata = false;

  const flush = () => {
    if (kind) {
      kinds[kind] = (kinds[kind] || 0) + 1;
      resources.push({ kind, name: name || null, namespace: namespace || null });
    }
    kind = null;
    name = null;
    namespace = null;
    inMetadata = false;
  };

  for (const line of manifest.split('\n')) {
    if (line.startsWith('---')) {
      flush();
      continue;
    }
    const kindMatch = /^kind:\s*(\S+)/.exec(line);
    if (kindMatch) {
      kind = kindMatch[1];
      continue;
    }
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    // Any other column-0 key ends the metadata block.
    if (inMetadata && /^\S/.test(line)) inMetadata = false;
    if (!inMetadata) continue;
    const nameMatch = /^\s{2}name:\s*(\S+)/.exec(line);
    if (nameMatch && !name) name = nameMatch[1].replace(/^["']|["']$/g, '');
    const nsMatch = /^\s{2}namespace:\s*(\S+)/.exec(line);
    if (nsMatch && !namespace) namespace = nsMatch[1].replace(/^["']|["']$/g, '');
  }
  flush();
  return { kinds, resources };
}

/** One revision, flattened out of a decoded release payload. */
function revisionOf(decoded, secret) {
  const chart = isPlainObject(decoded.chart) ? decoded.chart : {};
  const metadata = isPlainObject(chart.metadata) ? chart.metadata : {};
  const info = isPlainObject(decoded.info) ? decoded.info : {};
  const chartDefaults = isPlainObject(chart.values) ? chart.values : {};
  const overrides = isPlainObject(decoded.config) ? decoded.config : {};
  const { kinds, resources } = parseManifest(decoded.manifest);

  return {
    name: decoded.name || (secret.metadata && secret.metadata.labels && secret.metadata.labels.name) || null,
    namespace: decoded.namespace || (secret.metadata && secret.metadata.namespace) || null,
    revision: Number(decoded.version) || null,
    status: info.status || null,
    description: info.description || null,
    firstDeployed: info.first_deployed || null,
    lastDeployed: info.last_deployed || null,
    chart: {
      name: metadata.name || null,
      version: metadata.version || null,
      appVersion: metadata.appVersion || null,
      apiVersion: metadata.apiVersion || null,
      description: metadata.description || null,
      type: metadata.type || null,
      dependencies: Array.isArray(metadata.dependencies)
        // `repository` goes through the value scrub: a private chart repo is often referenced as
        // `https://user:pw@repo`, and the host is the useful half.
        ? metadata.dependencies.map(d => ({
            name: d.name || null,
            version: d.version || null,
            repository: typeof d.repository === 'string' ? safeString(d.repository) : null
          }))
        : []
    },
    /** Only what an operator overrode — the `-f`/`--set` layer, credential leaves masked. */
    overrides: maskValues(overrides),
    /** `helm get values --all`: chart defaults with the overrides applied on top. */
    values: maskValues(mergeValues(chartDefaults, overrides)),
    hasChartDefaults: Object.keys(chartDefaults).length > 0,
    resourceKinds: kinds,
    resources,
    resourceCount: resources.length,
    hookCount: Array.isArray(decoded.hooks) ? decoded.hooks.length : 0
  };
}

/**
 * The only rendered kinds that carry a health state of their own.
 *
 * There is deliberately no generic "Ready" column here. Of the kinds a chart typically
 * renders, only these three report ready-vs-desired; a ConfigMap, a Secret, a Service or an
 * RBAC object either exists or does not, and inventing "Healthy" for them would put a green
 * tick next to objects nothing has ever verified. Anything not listed reports `health: null`,
 * which the UI renders as "—" rather than as a state.
 */
const HEALTH_KINDS = {
  Deployment: '/apis/apps/v1/deployments?limit=2000',
  StatefulSet: '/apis/apps/v1/statefulsets?limit=2000',
  DaemonSet: '/apis/apps/v1/daemonsets?limit=2000'
};

/**
 * Ready/desired for every Deployment, StatefulSet and DaemonSet in the cluster, keyed
 * `Kind/namespace/name`, so a release's rendered resources can be joined against what is
 * actually running. Reuses `workloads.readiness()` rather than re-reading the replica fields,
 * because a DaemonSet reports itself through different ones.
 *
 * `readable` per kind is not optional bookkeeping. A refused or truncated list yields an empty
 * index, which is indistinguishable from "the object is not there" — so without it, one missing
 * RBAC rule makes every workload in every release render a confident red "not found". A failed
 * read is never a zero; it has to say it could not tell.
 */
async function healthIndex({ cluster, token, listFn }) {
  const results = await Promise.all(
    Object.entries(HEALTH_KINDS).map(([kind, path]) =>
      safeList(listFn, { cluster, token }, path, `${kind.toLowerCase()} health`)
        .then(r => ({ kind, r }))
    )
  );
  const index = new Map();
  const readable = {};
  for (const { kind, r } of results) {
    readable[kind] = !r.unavailable && !r.truncated;
    for (const obj of r.items) {
      const meta = obj.metadata || {};
      if (!meta.name) continue;
      const { ready, desired, state } = workloads.readiness(obj, kind);
      index.set(`${kind}/${meta.namespace}/${meta.name}`, { ready, desired, state });
    }
  }
  return { index, readable, results: results.map(x => x.r) };
}

/**
 * Where this cluster's Helm keeps its release records — established by reading, not assumed.
 *
 * Helm 3 supports three storage drivers, and which one is in use is a property of the *client*
 * that ran `helm install`, invisible in the cluster except through the records themselves:
 *
 *   `secret`     (default) one Secret per revision, `sh.helm.release.v1.<name>.v<n>`
 *   `configmap`  (`HELM_DRIVER=configmap`) the identical layout in a ConfigMap
 *   `sql`        (`HELM_DRIVER=sql`) rows in an external Postgres — no Kubernetes object at all
 *
 * So the probe reads the default backend first and only pays for the second when the first
 * produced nothing usable. Three outcomes matter and none may be collapsed:
 *
 *   refused          → `forbidden`. The console's role lacks Secrets (or ConfigMaps), and the
 *                      right sentence names the service account, not the cluster. Reporting
 *                      "no releases" here is the exact lie this module exists to prevent.
 *   records found    → the backend is whichever one answered, and its records are the truth.
 *   both readable,
 *   neither has any  → a genuine zero *or* an SQL-backed installation. Indistinguishable from
 *                      inside the Kubernetes API, so the zero is reported AND the ambiguity is
 *                      stated. Inferring releases from live resource labels instead — the other
 *                      way to fill this hole — would invent a history that no record supports.
 */
const RELEASE_BACKENDS = [
  {
    id: 'secret',
    label: 'Secrets',
    read: 'helm release storage (Secrets)',
    /**
     * The same read, named for the *sentence* rather than for the completeness list.
     *
     * `read` is a terse feature label that has to sit in a comma-separated `unavailable` list, so
     * it reads as a noun phrase in a list. `capLabel` is spliced into "the read-only service
     * account cannot access …", where that noun phrase has to be the thing an admin grants access
     * to. Two labels rather than one compromise wording that reads badly in both places.
     */
    capLabel: 'the configured Helm Secret storage',
    path: '/api/v1/secrets?labelSelector=owner%3Dhelm&limit=2000',
    nsPath: (ns, sel) => `/api/v1/namespaces/${encodeURIComponent(ns)}/secrets?labelSelector=${sel}&limit=200`
  },
  {
    id: 'configmap',
    label: 'ConfigMaps',
    read: 'helm release storage (ConfigMaps)',
    capLabel: 'the configured Helm ConfigMap storage',
    path: '/api/v1/configmaps?labelSelector=owner%3Dhelm&limit=2000',
    nsPath: (ns, sel) => `/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps?labelSelector=${sel}&limit=200`
  }
];

/**
 * Decode every Helm release record in a list of Secrets or ConfigMaps.
 *
 * The two backends differ only in where the base64 layers sit — a Secret's `.data.release` is
 * base64 over Helm's own base64, a ConfigMap's is Helm's base64 alone — and `decodeRelease`
 * already tries both, so one function serves both. What must differ is the type guard: only a
 * Secret carries `helm.sh/release.v1`, and applying that check to a ConfigMap would discard every
 * record on a configmap-backed cluster.
 */
function releaseRecords(items, backendId) {
  const records = [];
  let undecodable = 0;
  for (const obj of items) {
    if (backendId === 'secret' && obj.type && obj.type !== HELM_SECRET_TYPE) continue;
    const encoded = obj.data && obj.data.release;
    if (!encoded) continue;
    const decoded = decodeRelease(encoded);
    if (!decoded) {
      undecodable += 1;
      continue;
    }
    records.push({ decoded, source: obj });
  }
  return { records, undecodable };
}

/**
 * The sentence for a storage backend that answered nothing. Split out because the release list,
 * the manifest endpoint and the per-release related read all have to say the same thing.
 *
 * ## Why the probes collapse into one name
 *
 * This console probes both Kubernetes-backed drivers because it cannot know which one a cluster
 * configured. A service account with no Secret access is usually refused on both, and enumerating
 * them — "cannot access the configured Helm Secret storage, the configured Helm ConfigMap storage" —
 * describes the console's probing strategy rather than the operator's problem. There is only ever
 * *one* configured store, so the refusal names the driver Helm uses unless `HELM_DRIVER` says
 * otherwise, and the full probe list stays in `detail` for whoever is actually debugging RBAC.
 */
function storageCapability({ feature, reads, records, backend }) {
  const list = (Array.isArray(reads) ? reads : []).filter(Boolean);
  const refusedStores = list.filter(r => r.capLabel && cap.isAccessRefusal(r));
  const forSentence =
    refusedStores.length > 1
      ? [
          {
            ...refusedStores[0],
            detail: `${refusedStores[0].detail || 'access refused'} (every Kubernetes-backed Helm driver was refused: ${refusedStores
              .map(r => r.label)
              .join(', ')})`
          },
          ...list.filter(r => !refusedStores.includes(r))
        ]
      : list;

  const verdict = cap.fromReads({
    feature,
    // `capLabel` wins where a read carries one, so the generated sentence names the thing an admin
    // grants — "the configured Helm Secret storage" — rather than the terse label the completeness
    // list needs. The read objects themselves keep `label`, which is what that list reads.
    reads: forSentence.map(r => (r && r.capLabel ? { ...r, label: r.capLabel } : r)),
    gotAnything: records > 0,
    notInstalledCause: 'the Kubernetes core API did not serve the Helm release store'
  });
  // Collapsing the probes shortened the sentence, not the facts: `missing` names every read that
  // could not be performed, because that is the list an admin fixes.
  if (refusedStores.length > 1) {
    return { ...verdict, missing: list.filter(r => r.unavailable).map(r => r.capLabel || r.label) };
  }
  if (verdict.state !== 'available') return verdict;
  if (records > 0) return cap.available(feature, { backend });
  // Readable, and empty. The count is honest; the ambiguity beside it is too.
  return cap.capability({
    feature,
    state: 'available',
    extra: {
      backend: 'none',
      sqlIndistinguishable: true,
      note:
        'No Helm release records exist in either Kubernetes-backed storage driver (Secrets or ConfigMaps, label owner=helm). A Helm installation configured with HELM_DRIVER=sql keeps its records in an external database that the Kubernetes API cannot reach, and from here that is indistinguishable from a cluster with no releases.'
    }
  });
}

/** A release's identity, `namespace/name`, from a decoded record or a metadata-only one. */
const releaseKey = r => `${r.decoded.namespace || r.source.metadata.namespace}/${r.decoded.name}`;

/**
 * Release revisions known only from their record's labels and creation time: no payload read, so
 * no values, manifest or resources. `last_deployed` is approximated by the creation time.
 */
function metadataRecords(items) {
  return items.map(source => {
    const m = source.metadata || {};
    const labels = m.labels || {};
    const date = m.creationTimestamp ? new Date(m.creationTimestamp) : null;
    return { source, decoded: {
      name: labels.name, namespace: m.namespace, version: Number(labels.version) || null,
      info: { status: labels.status || null, last_deployed: date && Number.isFinite(date.getTime()) ? date.toISOString() : null }
    } };
  }).filter(r => r.decoded.name && r.decoded.version);
}

/** Per release, the revision whose contents get read: the deployed one, else the highest version. */
function newestRevisions(metadata) {
  const deployed = r => r.decoded.info.status === 'deployed';
  const newest = new Map();
  for (const r of metadata) {
    const key = releaseKey(r);
    const prev = newest.get(key);
    if (!prev || (deployed(r) !== deployed(prev) ? deployed(r) : r.decoded.version > prev.decoded.version)) newest.set(key, r);
  }
  return newest;
}

/**
 * Read release records from whichever driver holds them, fleet-wide.
 *
 * Returns the winning backend, its records, and one capability verdict. The second read happens
 * only when the first yields nothing usable, so the default-driver cluster — every cluster this
 * console has met — pays exactly one request, as before.
 */
async function releaseStorage({ cluster, token, listFn }) {
  const reads = [];
  let chosen = null;

  for (const backend of RELEASE_BACKENDS) {
    // History is metadata only. Payload reads are restricted to deployed revisions, then
    // one newest record for each release without a deployed revision (e.g. failed install).
    const result = await safeList(listFn, { cluster, token, accept: METADATA_ONLY }, backend.path, backend.read);
    const deployedPath = backend.path.replace('owner%3Dhelm', encodeURIComponent('owner=helm,status=deployed'));
    // The contents read is the same `list` on the same resource, so an access refusal of the
    // metadata read is its answer too; any other failure of the index may still leave contents.
    const full = result.items.length || result.truncated || (result.unavailable && !cap.isAccessRefusal(result))
      ? await safeList(listFn, { cluster, token }, deployedPath, backend.read)
      : { ...result, items: [] };
    const backendReads = [result, full];
    const decodedFull = releaseRecords(full.items, backend.id);
    let undecodable = decodedFull.undecodable;
    let records = [...decodedFull.records];
    const loaded = new Set(records.map(releaseKey));
    const metadata = metadataRecords(result.items);
    const newest = newestRevisions(metadata);
    // Sequential fallback bounds API pressure even on clusters with many failed installs.
    for (const [key, r] of newest) {
      if (loaded.has(key)) continue;
      const selector = encodeURIComponent(`owner=helm,name=${r.decoded.name},version=${r.decoded.version}`);
      const read = await safeList(listFn, { cluster, token }, backend.nsPath(r.decoded.namespace, selector), backend.read);
      backendReads.push(read);
      const decoded = releaseRecords(read.items, backend.id);
      records.push(...decoded.records);
      undecodable += decoded.undecodable;
    }
    // A release whose current revision never arrived decoded is dropped whole, and says so.
    const have = new Set(records.map(r => `${releaseKey(r)}/${Number(r.decoded.version)}`));
    const dropped = new Set();
    for (const [key, r] of newest) {
      if (have.has(`${key}/${r.decoded.version}`)) continue;
      dropped.add(key);
      backendReads.push({ label: `${backend.read}: current revision contents`, unavailable: true, truncated: false, reason: 'UPSTREAM', detail: 'The current revision contents could not be decoded or were no longer returned.' });
    }
    if (dropped.size) records = records.filter(r => !dropped.has(releaseKey(r)));
    // Only publish metadata history beside a release whose current contents were read.
    // Otherwise the missing full record must not become empty values or healthy resources.
    const keys = new Set(records.map(releaseKey));
    for (const r of metadata) {
      const key = releaseKey(r);
      if (keys.has(key) && !have.has(`${key}/${r.decoded.version}`)) records.push(r);
    }
    // Multiple reads serve one logical Helm store. Keep one capability/completeness entry per
    // store, preserving a failed detail read when the metadata probe itself worked.
    const failedRead = backendReads.find(read => read.unavailable);
    const truncatedRead = backendReads.find(read => read.truncated);
    reads.push({ ...(failedRead || truncatedRead || result), capLabel: backend.capLabel });
    if (records.length > 0) {
      chosen = { backend, result, records, undecodable };
      break;
    }
    // Keep the first backend's undecodable tally even when we move on: Secrets that carry the
    // Helm type but will not decode are a gap in the list, whichever driver is in use.
    if (!chosen && undecodable > 0) chosen = { backend, result, records: [], undecodable };
  }

  const backendId = chosen && chosen.records.length > 0 ? chosen.backend.id : 'none';
  return {
    backendId,
    records: chosen ? chosen.records : [],
    undecodable: chosen ? chosen.undecodable : 0,
    reads,
    capability: storageCapability({
      feature: 'Helm release storage',
      reads,
      records: chosen ? chosen.records.length : 0,
      backend: backendId
    })
  };
}

async function collect({ cluster, token, listFn = list }) {
  // Label selector, not a field selector on name: this is the LIST that the reader role is
  // guaranteed to be allowed, across every namespace at once. The health index runs in parallel
  // and is deliberately independent of it — live resource inspection has to survive a storage
  // read that was refused, because the two need different RBAC and only one of them is optional.
  const [storage, health] = await Promise.all([
    releaseStorage({ cluster, token, listFn }),
    healthIndex({ cluster, token, listFn })
  ]);

  const byRelease = new Map();
  let undecodable = storage.undecodable;

  for (const { decoded, source } of storage.records) {
    const revision = revisionOf(decoded, source);
    if (!revision.name) continue;
    const key = `${revision.namespace}/${revision.name}`;
    if (!byRelease.has(key)) byRelease.set(key, []);
    byRelease.get(key).push(revision);
  }

  const releases = [];
  for (const revisions of byRelease.values()) {
    revisions.sort((a, b) => (b.revision || 0) - (a.revision || 0));
    // The deployed revision is the truth about what is running; Helm leaves older ones as
    // `superseded` and a failed upgrade can leave a higher revision that never took effect.
    const current = revisions.find(r => r.status === 'deployed') || revisions[0];
    releases.push({
      ...current,
      /**
       * The rendered inventory joined to live health. A manifest entry with no explicit
       * namespace lands in the release's namespace, which is how Helm installs it.
       * `linkable` tells the UI which rows are worth making clickable — the ones the
       * Workloads tab can actually open. `healthReadable: false` means the join could not be
       * performed at all for that kind, which the UI must render as "unreadable" and never as
       * "not found": stating a live object is absent because a list was refused is a lie.
       */
      resources: current.resources.map(r => {
        const ns = r.namespace || current.namespace;
        const linkable = Object.prototype.hasOwnProperty.call(HEALTH_KINDS, r.kind);
        return {
          ...r,
          namespace: ns,
          linkable,
          healthReadable: linkable ? health.readable[r.kind] !== false : true,
          health: linkable ? (health.index.get(`${r.kind}/${ns}/${r.name}`) || null) : null
        };
      }),
      revisions: revisions.map(r => ({
        revision: r.revision,
        status: r.status,
        chartVersion: r.chart.version,
        appVersion: r.chart.appVersion,
        description: r.description,
        lastDeployed: r.lastDeployed
      })),
      revisionCount: revisions.length,
      /** True when the highest revision is not the deployed one — an upgrade that did not land. */
      pendingRevision: revisions[0].status !== 'deployed' ? revisions[0].revision : null
    });
  }

  releases.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));

  /**
   * What this cluster can and cannot answer, feature by feature.
   *
   * Three separate verdicts because they fail separately and an operator's next action differs
   * for each. Values, Manifest and History all come out of the same decoded release record, so
   * they share the storage verdict — if the store is unreadable, none of the three can be
   * produced, and inferring any of them from live resource labels would be fabrication. Live
   * resource inspection is a different read with different RBAC, so it keeps its own verdict and
   * stays usable when the store does not: an operator locked out of Helm's records can still see
   * what is actually running.
   */
  const liveInspection = cap.fromReads({
    feature: 'Live resource inspection',
    reads: health.results,
    gotAnything: health.results.some(r => !r.unavailable)
  });
  const storageFeature = storage.capability;
  /**
   * A record-derived pane's verdict: the storage state, under the pane's own name.
   *
   * `sentence` is passed rather than generated because the default template — `<feature> is
   * unavailable because …` — is only grammatical for a singular feature name, and "Helm release
   * values is unavailable" would be the one sentence on the screen an operator remembers.
   */
  const fromStorage = (feature, sentence) =>
    storageFeature.state === 'available'
      ? cap.available(feature)
      : cap.capability({
          feature,
          state: storageFeature.state,
          cause: storageFeature.cause,
          detail: storageFeature.detail,
          missing: storageFeature.missing,
          sentence: storageFeature.cause ? sentence(storageFeature.cause) : undefined
        });

  return {
    releases,
    /**
     * The storage driver actually in use, and whether its records could be read. `backend: 'none'`
     * with a trusted verdict means both Kubernetes drivers were readable and empty — see
     * `releaseStorage`, which explains why that is reported rather than guessed at.
     */
    storage: {
      backend: storage.backendId,
      drivers: RELEASE_BACKENDS.map(b => ({ id: b.id, label: b.label })),
      capability: storageFeature
    },
    capabilities: {
      releases: storageFeature,
      // Named individually so the UI can print the exact sentence the operator needs, per pane,
      // rather than one page-level "Helm unavailable" that says nothing about which pane died.
      values: fromStorage('Helm release values', c => `Helm release values are unavailable because ${c}.`),
      manifest: fromStorage('Helm rendered manifest', c => `The Helm rendered manifest is unavailable because ${c}.`),
      history: fromStorage('Helm release history', c => `Helm release history is unavailable because ${c}.`),
      liveInspection
    },
    counts: {
      releases: releases.length,
      namespaces: new Set(releases.map(r => r.namespace)).size,
      notDeployed: releases.filter(r => r.status !== 'deployed').length,
      /**
       * Secrets that carried the Helm type but whose payload would not decode. Surfaced
       * rather than swallowed: a non-zero count means the release list below is short, and
       * an operator reading "3 releases" must be able to tell that from "3 releases and two
       * we could not read".
       */
      undecodable
    },
    summary: {
      unavailable: unavailableLabels([...storage.reads, ...health.results]),
      truncated: truncatedLabels([...storage.reads, ...health.results])
    }
  };
}

// ----------------------------------------------------------------- manifest view

/**
 * Ceilings for the on-request manifest read.
 *
 * Measured on a live cluster (2026-09-16): the largest rendered manifest across 55 release
 * revisions was 63.6 kB. These are ceilings rather than filters — set just under the point
 * where a single release would cost more than the screen can usefully show, and far enough
 * above today's largest that an ordinary chart growing does not start truncating. Past a
 * limit the content is cut and the read reports `truncated`, which the existing completeness
 * vocabulary already renders: a short manifest must never look like a complete one.
 */
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_CHART_FILE_BYTES = 128 * 1024;
const MAX_CHART_FILES_TOTAL = 1024 * 1024;

/**
 * Split a rendered manifest into its YAML documents, keeping Helm's `# Source:` comment.
 *
 * That comment is the reason this view is worth building: Helm writes it above every document
 * it renders, so the flat manifest can be presented as the chart's files rather than as one
 * 60 kB scroll. It is the only link back from "this Deployment" to "the template that made
 * it", and nothing else in the payload carries it.
 */
function splitManifest(manifest) {
  if (typeof manifest !== 'string' || manifest.length === 0) return [];
  const docs = [];
  let cur = null;
  const start = () => ({ source: null, kind: null, name: null, namespace: null, lines: [] });
  const push = () => {
    if (cur && cur.lines.some(l => l.trim() && !l.trim().startsWith('#'))) docs.push(cur);
    cur = null;
  };

  for (const line of manifest.split('\n')) {
    if (/^---\s*$/.test(line)) {
      push();
      cur = start();
      continue;
    }
    if (!cur) cur = start();
    const src = /^#\s*Source:\s*(\S+)/.exec(line);
    if (src && !cur.source) cur.source = src[1];
    cur.lines.push(line);
  }
  push();

  for (const doc of docs) {
    let inMetadata = false;
    for (const line of doc.lines) {
      const kindMatch = /^kind:\s*(\S+)/.exec(line);
      if (kindMatch) {
        doc.kind = kindMatch[1];
        continue;
      }
      if (/^metadata:\s*$/.test(line)) {
        inMetadata = true;
        continue;
      }
      if (inMetadata && /^\S/.test(line)) inMetadata = false;
      if (!inMetadata) continue;
      const nameMatch = /^\s{2}name:\s*(\S+)/.exec(line);
      if (nameMatch && !doc.name) doc.name = nameMatch[1].replace(/^["']|["']$/g, '');
      const nsMatch = /^\s{2}namespace:\s*(\S+)/.exec(line);
      if (nsMatch && !doc.namespace) doc.namespace = nsMatch[1].replace(/^["']|["']$/g, '');
    }
  }
  return docs;
}

/** A `key:` line, tolerant of list markers (`- name: x`) and quoted JSON keys. */
const YAML_KEY = /^(\s*)([^:\s][^:]*):(.*)$/;

/**
 * Keys in a rendered manifest that NAME an object rather than hold a credential.
 *
 * This is `REFERENCE_KEYS` widened for YAML, and it is what keeps the view worth opening.
 * Kubernetes manifests are full of secret-ish key names that are all pointers —
 * `imagePullSecrets: [{name}]`, `secretKeyRef: {name, key}`, a volume's `secret.secretName`.
 * Masking them hides the one thing the line is for (which Secret to go and look in) while
 * protecting nothing, because the value is not there. Verified against the live cluster on
 * 2026-09-16, where the first cut redacted all three.
 */
const POINTER_KEYS = /^(secret|configmap)(key)?ref$|^valuefrom$|^(secret|configmap|claim|serviceaccount)name$|^imagepullsecrets$/i;

/** YAML scalars that cannot be a credential, whatever the key above them says. */
const NON_CREDENTIAL_SCALAR = /^(true|false|null|~|-?\d+(\.\d+)?)$/i;

/**
 * Redact a YAML (or JSON) document line by line, preserving its shape.
 *
 * Two rules, and the split between them is the whole point:
 *
 *  - **By document kind.** Everything under `data:`/`stringData:` on a `kind: Secret` is a
 *    credential by definition, and `server/fleet` returns Secret keys and never Secret values.
 *    The identical `data:` block on a ConfigMap is ordinary configuration an operator needs
 *    to read. A key-name rule cannot tell those apart — only the kind can, which is why this
 *    is not simply `maskValues` pointed at YAML.
 *  - **By key name and value shape**, everywhere: the same `isSensitiveKey` / `safeString`
 *    pair the values viewer already uses, so an annotation holding a bearer token is caught
 *    wherever it sits.
 *
 * `secretLike` is passed true for an UNRECOGNISED kind as well as for `Secret`. A document
 * whose `kind:` could not be parsed is malformed, and the safe reading of malformed input is
 * that it might be a Secret — over-masking one odd document is recoverable, leaking one is
 * not. Keys always survive, so the screen still says the field is set.
 */
function redactDocument(lines, secretLike) {
  const out = [];
  let block = null;
  /**
   * The `{name, value}` env pair, carried across lines.
   *
   * This is the single most common way a credential reaches a rendered manifest:
   * `env: [- name: API_KEY, value: sk-live-…]`. Neither key is credential-shaped on its own,
   * so a purely per-line rule hands the value straight to the browser — `maskValues` already
   * solves this for the values tree, and a line scanner needs its own version. The NAME
   * decides whether the VALUE is masked.
   */
  let pendingName = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (block) {
      const indent = line.length - line.trimStart().length;
      if (trimmed !== '' && indent <= block.indent) {
        block = null;
      } else {
        if (trimmed === '') out.push(line);
        else if (block.mode === 'map') {
          const km = YAML_KEY.exec(line);
          out.push(km ? `${km[1]}${km[2]}: ${MASKED}` : `${' '.repeat(indent)}${MASKED}`);
        }
        // A masked block scalar emits its placeholder once, on the key line, and swallows
        // the body — echoing one `[redacted]` per line of a PEM key is just noise.
        continue;
      }
    }

    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    const km = YAML_KEY.exec(line);
    if (!km) {
      out.push(line);
      continue;
    }

    const [, indent, key, rest] = km;
    const value = rest.trim();
    // `- name: FOO` is a key at the list item's indent, two characters in.
    const bare = key.replace(/^-\s*/, '');
    const keyIndent = indent.length + (key.length - bare.length);
    if (pendingName && keyIndent < pendingName.indent) pendingName = null;

    const pointer = POINTER_KEYS.test(bare);
    const sensitive = !pointer && (
      isSensitiveKey(bare) ||
      (bare === 'value' && pendingName !== null && pendingName.indent === keyIndent && pendingName.sensitive)
    );

    if (bare === 'name' && value !== '') {
      pendingName = { indent: keyIndent, sensitive: isSensitiveKey(value.replace(/^["']|["']$/g, '')) };
    } else if (bare === 'value') {
      pendingName = null;
    }

    if (secretLike && /^(data|stringData)$/i.test(bare) && value === '') {
      out.push(line);
      block = { indent: indent.length, mode: 'map' };
      continue;
    }
    // A nested map under a credential-named key is STRUCTURE, not credential material — see
    // POINTER_KEYS. Opening a masked block here is what redacted every `imagePullSecrets`
    // entry on the live cluster. Its leaves are still judged on their own keys and on the
    // shape of their values, which is where an actual inline credential would be caught.
    if (value === '') {
      out.push(line);
      continue;
    }
    // A block scalar: `key: |` with the content on the following indented lines.
    if (/^[|>][-+0-9]*$/.test(value)) {
      if (sensitive) {
        out.push(`${indent}${key}: ${MASKED}`);
        block = { indent: indent.length, mode: 'scalar' };
      } else {
        out.push(line);
      }
      continue;
    }
    // Matches `maskValues`: a credential is never a boolean or a number. Without this,
    // `automountServiceAccountToken: true` reads as redacted because the key says "token".
    if (NON_CREDENTIAL_SCALAR.test(value)) {
      out.push(line);
      continue;
    }
    out.push(sensitive ? `${indent}${key}: ${MASKED}` : `${indent}${key}: ${safeString(value)}`);
  }

  return out;
}

/** Cut a string to a byte ceiling, reporting whether anything was removed. */
function capText(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * The chart's own files as Helm stored them: `templates/*.yaml` before rendering, plus
 * anything under the chart's `files/`.
 *
 * Templates are mostly `{{ }}` rather than literals, but `chart.files` is not — on the live
 * cluster it holds `xs-security.json` and `values/sandbox.yaml`, which are exactly the kind
 * of chart input that sometimes carries a client secret. So both go through the same
 * key-and-value redaction. The kind-driven `data:` rule does NOT apply here: an unrendered
 * template has no settled kind, and masking every `data:` block would blank the ConfigMap
 * templates that are the most useful thing to read.
 */
function chartFiles(chart) {
  const groups = [
    ['template', Array.isArray(chart.templates) ? chart.templates : []],
    ['file', Array.isArray(chart.files) ? chart.files : []]
  ];
  const out = [];
  let budget = MAX_CHART_FILES_TOTAL;

  for (const [type, entries] of groups) {
    for (const entry of entries) {
      if (!isPlainObject(entry) || typeof entry.name !== 'string') continue;
      let decoded;
      try {
        decoded = Buffer.from(String(entry.data || ''), 'base64').toString('utf8');
      } catch {
        continue;
      }
      const bytes = decoded.length;
      if (budget <= 0) {
        out.push({ name: entry.name, type, bytes, content: '', truncated: true });
        continue;
      }
      const capped = capText(decoded, Math.min(MAX_CHART_FILE_BYTES, budget));
      budget -= capped.text.length;
      out.push({
        name: entry.name,
        type,
        bytes,
        content: redactDocument(capped.text.split('\n'), false).join('\n'),
        truncated: capped.truncated
      });
    }
  }
  return out;
}

/**
 * One release's rendered manifest and chart source, redacted, on request.
 *
 * Reads through the same namespaced LIST the collector uses rather than a GET-by-name, for
 * the reason documented at the top of this file: the reader role is guaranteed `list` on
 * Secrets and may one day not grant `get`.
 *
 * A release that is genuinely absent throws a typed NOT_FOUND so the route can answer 404 —
 * this endpoint is reached from a link, and a stale link must read "deleted" rather than
 * "cluster unreachable". But an absence can only be asserted when the list was actually
 * readable: if the read was refused, the envelope reports `unavailable` and claims nothing.
 */
async function manifest({ cluster, token, listFn = list, namespace, name, revision = null }) {
  const selector = encodeURIComponent(`owner=helm,name=${name}${revision === null ? ',status=deployed' : `,version=${revision}`}`);
  // Same driver order as the fleet list, and for the same reason: the default backend is read
  // first, the second only when it produced no record. A release stored in a ConfigMap must not
  // read as "deleted" here just because it is not in a Secret.
  const reads = [];
  let revisions = [];
  let undecodable = 0;
  for (const backend of RELEASE_BACKENDS) {
    const read = await safeList(listFn, { cluster, token }, backend.nsPath(namespace, selector), backend.read);
    reads.push({ ...read, capLabel: backend.capLabel });
    let decoded = releaseRecords(read.items, backend.id);
    if (revision === null && !decoded.records.length && !read.unavailable) {
      const meta = await safeList(listFn, { cluster, token, accept: METADATA_ONLY },
        backend.nsPath(namespace, encodeURIComponent(`owner=helm,name=${name}`)), backend.read);
      reads.push({ ...meta, capLabel: backend.capLabel });
      const latest = meta.items.map(o => Number((o.metadata?.labels || {}).version)).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
      if (latest > 0) {
        const fallback = await safeList(listFn, { cluster, token },
          backend.nsPath(namespace, encodeURIComponent(`owner=helm,name=${name},version=${latest}`)), backend.read);
        reads.push({ ...fallback, capLabel: backend.capLabel });
        decoded = releaseRecords(fallback.items, backend.id);
      }
    }
    undecodable += decoded.undecodable;
    const matching = decoded.records
      .map(r => r.decoded)
      .filter(r => !r.name || r.name === name);
    if (matching.length > 0) {
      revisions = matching;
      break;
    }
  }
  revisions.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));

  const storage = storageCapability({
    feature: 'Helm release history',
    reads,
    records: revisions.length,
    backend: revisions.length > 0 ? 'secret' : 'none'
  });

  const wanted = revision === null
    ? revisions.find(r => isPlainObject(r.info) && r.info.status === 'deployed') || revisions[0]
    : revisions.find(r => Number(r.version) === Number(revision));

  if (!wanted) {
    if (reads.some(r => r.unavailable)) {
      // The list was refused or failed, so "not found" would be a claim we cannot make. The
      // capability carries the exact sentence — the caller renders that, not an empty pane.
      //
      // The full shape, with every field empty rather than absent: a consumer that reached this
      // response having been told the store was readable would otherwise find `values` undefined
      // and fall over while trying to explain why it has nothing. Empty-and-explained beats absent.
      return {
        name, namespace, revision: null, status: null, documents: [], chartFiles: [],
        capability: storage,
        overrides: {},
        values: {},
        defaults: {},
        hasChartDefaults: false,
        chartMetadata: {
          name: null, version: null, appVersion: null, apiVersion: null,
          description: null, type: null, home: null, keywords: [], maintainers: []
        },
        counts: { documents: 0, chartFiles: 0, manifestBytes: 0, undecodable: 0 },
        summary: { unavailable: unavailableLabels(reads), truncated: truncatedLabels(reads) }
      };
    }
    throw new ClusterError(NOT_FOUND,
      revision === null
        ? `Helm release '${name}' not found in namespace '${namespace}'`
        : `Helm release '${name}' has no revision ${revision} in namespace '${namespace}'`,
      { cluster: cluster.id, status: 404 });
  }

  const chart = isPlainObject(wanted.chart) ? wanted.chart : {};
  const info = isPlainObject(wanted.info) ? wanted.info : {};
  const raw = typeof wanted.manifest === 'string' ? wanted.manifest : '';
  const capped = capText(raw, MAX_MANIFEST_BYTES);

  const documents = splitManifest(capped.text).map(doc => ({
    source: doc.source,
    kind: doc.kind,
    name: doc.name,
    namespace: doc.namespace || namespace,
    /** True when this document's values were blanked by the kind rule, not the key rule. */
    redactedByKind: doc.kind === 'Secret' || doc.kind === null,
    content: redactDocument(doc.lines, doc.kind === 'Secret' || doc.kind === null).join('\n').trim()
  }));

  const files = chartFiles(chart);
  const chartDefaults = isPlainObject(chart.values) ? chart.values : {};
  const overrides = isPlainObject(wanted.config) ? wanted.config : {};
  const chartMeta = isPlainObject(chart.metadata) ? chart.metadata : {};

  return {
    name,
    namespace,
    revision: Number(wanted.version) || null,
    status: info.status || null,
    description: info.description || null,
    lastDeployed: info.last_deployed || null,
    /**
     * This revision's values, masked by the same rules as the list response.
     *
     * Carried here rather than on the list, because it is only needed when a revision is being
     * READ — either the values viewer, or a comparison of two revisions, both of which are one
     * request per revision. Putting every revision's values on the list response would put the
     * whole history's configuration on the wire every time the Helm tab opens.
     */
    overrides: maskValues(overrides),
    values: maskValues(mergeValues(chartDefaults, overrides)),
    /** The chart's own defaults, unmerged — the "Default Values" pane, and the compare baseline. */
    defaults: maskValues(chartDefaults),
    hasChartDefaults: Object.keys(chartDefaults).length > 0,
    chartMetadata: {
      name: chartMeta.name || null,
      version: chartMeta.version || null,
      appVersion: chartMeta.appVersion || null,
      apiVersion: chartMeta.apiVersion || null,
      description: chartMeta.description || null,
      type: chartMeta.type || null,
      home: typeof chartMeta.home === 'string' ? safeString(chartMeta.home) : null,
      keywords: Array.isArray(chartMeta.keywords) ? chartMeta.keywords.map(String) : [],
      maintainers: Array.isArray(chartMeta.maintainers)
        ? chartMeta.maintainers.map(m => ({ name: (m && m.name) || null }))
        : []
    },
    documents,
    chartFiles: files,
    /** Which of the two Kubernetes storage drivers answered, and whether it answered in full. */
    capability: storage,
    counts: {
      documents: documents.length,
      chartFiles: files.length,
      manifestBytes: raw.length,
      /** Helm-typed Secrets for this release whose payload would not decode. */
      undecodable
    },
    summary: {
      unavailable: unavailableLabels(reads),
      truncated: [
        ...truncatedLabels(reads),
        ...(capped.truncated ? ['rendered manifest'] : []),
        ...(files.some(f => f.truncated) ? ['chart source files'] : [])
      ]
    }
  };
}

export default {
  collect, decodeRelease, mergeValues, parseManifest, maskValues, healthIndex,
  manifest, splitManifest, redactDocument, chartFiles,
  HEALTH_KINDS, MASKED, MAX_MANIFEST_BYTES
};
