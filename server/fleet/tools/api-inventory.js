#!/usr/bin/env node
/**
 * Enumerate a cluster's entire API surface and write it up as a document the dashboard's
 * layout can be designed against.
 *
 *   npm run fleet:inventory -- --kubeconfig ~/Downloads/kubeconfig--platform-sbx.yaml \
 *                              --token-file /tmp/fleet-reader.token
 *
 *   npm run fleet:inventory -- --api-url https://api.example.com --ca-file ca.pem \
 *                              --token-file token.txt --out docs/research/MY_CLUSTER.md
 *
 * ## Why this exists
 *
 * Every panel in this console was designed by someone guessing which Kinds a Kyma cluster
 * actually carries and how many of each. The guess is usually right and occasionally
 * expensive: a panel built for a resource that is present but always empty looks broken,
 * and a resource holding four thousand objects needs a very different screen from one
 * holding four. This answers both questions from the cluster itself, per cluster, in one
 * run — and it answers a third the guess cannot reach, which is whether the *reader
 * account* can see the resource at all.
 *
 * ## What it does, in order
 *
 *   1. aggregated discovery (KEP-3352) against `/apis` AND `/api`, one request each,
 *      falling back to per-group `APIResourceList` on a server that ignores the header
 *   2. one `?limit=1` GET per listable resource, for an exact count and a permission verdict
 *   3. a value-free field digest from the single sampled object
 *   4. a JSON artefact and a markdown document, grouped into dashboard domains
 *
 * ## What it will not do
 *
 * **It is read-only and it is cluster-agnostic.** Only GET, and never against a
 * subresource. There is not a cluster name, hostname or Kind anywhere in the logic — run
 * it against a bare kubeadm cluster and it produces the same document with different rows.
 *
 * **It writes no value into the output.** Field digests are paths and JSON types;
 * `Secret` and the token-shaped Kinds are counted but never fetched. See the invariants
 * at the top of `api-inventory-model.js`.
 *
 * **It never turns a failed read into a zero.** A resource that 403s is reported as
 * refused, with the API server's own message; a count is `null` unless a page actually
 * came back.
 *
 * ## Flags
 *
 *   --kubeconfig <path>   read apiUrl and CA from a kubeconfig  (--context picks a context)
 *   --api-url <url>       ...or give them directly
 *   --ca-file <path>
 *   --token-file <path>   the bearer token; also $FLEET_INVENTORY_TOKEN
 *   --namespace <ns>      probe namespaced types in one namespace instead of cluster-wide
 *   --out <path>          markdown output   (default docs/research/CLUSTER_API_INVENTORY.md)
 *   --json <path>         JSON artefact     (default alongside --out, .json)
 *   --concurrency <n>     parallel probes   (default 8, matching the API client's own gate)
 *   --no-sample           counts and permissions only; skip every field digest
 *   --no-probe            discovery only; contact the cluster twice and stop
 *   --quiet               no progress on stderr
 *
 * The token is read from a file rather than an argument on purpose: an argument is visible
 * in `ps` and lands in shell history.
 */
import fs from 'node:fs';
import path from 'node:path';

import k8sModule from '../k8s.js';
const { call } = k8sModule;
import kubeconfigModule from '../kubeconfig.js';
const { describeKubeconfig } = kubeconfigModule;
import apiInventoryModelModule from './api-inventory-model.js';
import { fileURLToPath } from 'node:url';
const {
  fromAggregated, fromLegacy, countFromPage, fieldDigest, byDomain, summarise, NEVER_SAMPLE
} = apiInventoryModelModule;

/** The header that turns `/apis` from 60 round-trips into one. A server that predates it
 *  ignores the header and answers `APIGroupList`, which is why the caller checks `kind`. */
const AGGREGATED_ACCEPT = 'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList';
const DEFAULT_OUT = path.join('docs', 'research', 'CLUSTER_API_INVENTORY.md');
const PROBE_TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    const key = arg.slice(2);
    if (key.startsWith('no-')) { flags[key.slice(3)] = false; continue; }
    if (key === 'quiet') { flags.quiet = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    flags[key] = value;
  }
  return flags;
}

/**
 * Resolve the three things a read needs: where, how to trust it, and who we are.
 *
 * The kubeconfig path goes through the same `describeKubeconfig` the Add Cluster screen
 * uses, so this tool inherits its refusals for free — non-https, `insecure-skip-tls-verify`
 * and a CA that lives in a file the kubeconfig points at are all rejected here without a
 * second implementation to keep in step.
 */
function resolveTarget(flags) {
  const tokenFile = flags['token-file'];
  const token = tokenFile
    ? fs.readFileSync(tokenFile, 'utf8').trim()
    : (process.env.FLEET_INVENTORY_TOKEN || '').trim();
  if (!token) {
    throw new Error('a bearer token is required: --token-file <path> or $FLEET_INVENTORY_TOKEN');
  }

  if (flags.kubeconfig) {
    const described = describeKubeconfig(
      fs.readFileSync(flags.kubeconfig, 'utf8'),
      { contextName: flags.context }
    );
    if (!described.caData) {
      throw new Error('the kubeconfig has no certificate-authority-data; re-export it with '
        + '`kubectl config view --raw --minify --flatten`');
    }
    return {
      token,
      cluster: { id: described.contextName, apiUrl: described.apiUrl, caData: described.caData },
      context: described.contextName
    };
  }

  if (!flags['api-url']) throw new Error('either --kubeconfig or --api-url is required');
  if (!/^https:\/\//.test(flags['api-url'])) throw new Error('--api-url must be https');
  const caData = flags['ca-file'] ? fs.readFileSync(flags['ca-file'], 'utf8') : null;
  if (!caData) throw new Error('--ca-file is required with --api-url; without it the API server cannot be verified');
  return {
    token,
    cluster: { id: 'target', apiUrl: flags['api-url'].replace(/\/+$/, ''), caData },
    context: null
  };
}

/* ------------------------------------------------------------------------ discovery */

/**
 * Every resource the API server advertises, from both roots.
 *
 * `/apis` and `/api` are two separate calls and always will be — the core group is not in
 * `/apis`, and forgetting it silently costs pods, nodes, namespaces, services, configmaps
 * and secrets, which is to say most of what a dashboard shows.
 */
async function discover({ cluster, token }) {
  const roots = [
    { path: '/apis', label: 'grouped' },
    { path: '/api', label: 'core' }
  ];
  const entries = [];
  const modes = [];

  for (const root of roots) {
    const doc = await call({ cluster, token, path: root.path, accept: AGGREGATED_ACCEPT });
    if (doc && doc.kind === 'APIGroupDiscoveryList') {
      modes.push(`${root.label}:aggregated-v2`);
      entries.push(...fromAggregated(doc));
      continue;
    }
    modes.push(`${root.label}:legacy`);
    entries.push(...await discoverLegacy({ cluster, token, root: root.path, doc }));
  }

  // Two groups can advertise the same plural, and one group can advertise the same
  // resource at several versions. The key keeps all of them distinct; the document then
  // marks which version is preferred rather than silently choosing.
  const seen = new Set();
  return {
    mode: modes.join(', '),
    entries: entries.filter(e => {
      const key = `${e.group}/${e.version}/${e.resource}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  };
}

/**
 * The pre-1.30 path: walk each group's versions and fetch one `APIResourceList` apiece.
 *
 * Slow — one request per group/version — but it is the difference between this tool
 * working on an older cluster and refusing to run on it.
 */
async function discoverLegacy({ cluster, token, root, doc }) {
  const out = [];
  if (root === '/api') {
    const versions = (doc && doc.versions) || ['v1'];
    for (const [i, version] of versions.entries()) {
      const list = await call({ cluster, token, path: `/api/${version}` });
      out.push(...fromLegacy(list, { group: '', version, preferred: i === 0 }));
    }
    return out;
  }
  for (const group of (doc && doc.groups) || []) {
    const preferred = group.preferredVersion && group.preferredVersion.version;
    for (const v of group.versions || []) {
      const list = await call({ cluster, token, path: `/apis/${group.name}/${v.version}` });
      out.push(...fromLegacy(list, {
        group: group.name, version: v.version, preferred: v.version === preferred
      }));
    }
  }
  return out;
}

/* --------------------------------------------------------------------------- probes */

/**
 * Read one page of one resource and record what came back.
 *
 * `limit=1` is what makes this affordable across two hundred resources: the server returns
 * one object and, in `metadata.remainingItemCount`, how many more there are. A plain `call`
 * is used rather than the dashboard's `list()` helper because `list()` asks for the watch
 * cache (`resourceVersion=0`), and the watch cache does not paginate — it would return
 * every object in the cluster, for every Kind, and still not tell us the count directly.
 *
 * The outcome vocabulary matches the console's: `forbidden` means RBAC said no, `absent`
 * means the endpoint 404'd (a CRD deleted between discovery and the probe), `unreachable`
 * and `error` mean the read did not happen. Only `ok` carries a count.
 */
async function probe({ cluster, token, entry, namespace, sample }) {
  const base = namespace && entry.scope === 'Namespaced'
    ? entry.namespacedListPath.replace('{namespace}', encodeURIComponent(namespace))
    : entry.listPath;
  const path_ = `${base}?limit=1`;

  try {
    const page = await call({ cluster, token, path: path_, timeoutMs: PROBE_TIMEOUT_MS });
    const count = countFromPage(page);
    const first = Array.isArray(page && page.items) ? page.items[0] : null;
    const sampled = sample && first && !NEVER_SAMPLE.has(entry.kind);
    return {
      probe: { outcome: 'ok', count, scope: namespace ? `namespace/${namespace}` : 'cluster-wide' },
      fields: sampled ? fieldDigest(first) : null,
      sampleSkipped: first && !sampled ? (NEVER_SAMPLE.has(entry.kind) ? 'never-sampled' : 'disabled') : null
    };
  } catch (err) {
    const code = err && err.code;
    const outcome = code === 'FORBIDDEN' || code === 'UNAUTHENTICATED' ? 'forbidden'
      : code === 'NOT_FOUND' ? 'absent'
        : code === 'UNREACHABLE' ? 'unreachable'
          : 'error';
    return {
      // count stays undefined. A refused read is not an empty collection, and the whole
      // point of writing this document down is that somebody will trust the numbers in it.
      probe: { outcome, count: null, code: code || null, message: err.message },
      fields: null,
      sampleSkipped: null
    };
  }
}

/** Run `work` over `items` with a fixed number of workers. */
async function pool(items, width, work) {
  const queue = [...items.entries()];
  const workers = Array.from({ length: Math.min(width, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await work(next[1], next[0]);
    }
  });
  await Promise.all(workers);
}

/* -------------------------------------------------------------------------- reports */

function fence(s) { return String(s).replace(/\|/g, '\\|'); }

/** `1234` -> `1,234`; a `null` count prints as the reason it is null, never as a number. */
function countCell(e) {
  // A type that does not support `list` was never probed, and saying `—` would leave it
  // looking like a read that failed. It is a POST-only endpoint (`Binding`, a review API):
  // no collection exists to count.
  if (!e.listable) return '*not listable*';
  if (!e.probe) return '—';
  if (e.probe.outcome === 'ok') return e.probe.count.toLocaleString('en-US');
  return { forbidden: '`forbidden`', absent: '`absent`', unreachable: '`unreachable`' }[e.probe.outcome] || '`error`';
}

function renderMarkdown({ meta, entries, summary }) {
  const L = [];
  const domains = byDomain(entries);

  L.push('# Cluster API inventory');
  L.push('');
  L.push('**Generated** — do not edit by hand. Regenerate with:');
  L.push('');
  L.push('```');
  L.push('npm run fleet:inventory -- --kubeconfig <path> --token-file <path>');
  L.push('```');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| API server | \`${meta.apiUrl}\` |`);
  if (meta.context) L.push(`| kubeconfig context | \`${meta.context}\` |`);
  L.push(`| Kubernetes | ${meta.version ? `\`${meta.version.gitVersion}\` (platform \`${meta.version.platform}\`)` : '`unavailable`'} |`);
  L.push(`| Generated at | ${meta.generatedAt} |`);
  L.push(`| Discovery | ${meta.discoveryMode} |`);
  L.push(`| Probe scope | ${meta.namespace ? `namespace \`${meta.namespace}\`` : 'cluster-wide'} |`);
  L.push(`| Identity | \`${meta.identity || 'unknown'}\` |`);
  L.push('');
  L.push('**Method — read-only.** Discovery (`GET /apis`, `GET /api`) plus one `GET '
    + '<collection>?limit=1` per listable resource. Nothing was created, applied, patched or '
    + 'deleted, and no subresource was called.');
  L.push('');
  L.push('**No values.** Field shapes are paths and JSON types only. `Secret` and '
    + 'token-shaped Kinds are counted but never fetched. Map-like fields (`data`, '
    + '`annotations`, `labels`, …) are recorded as `map` and not entered, because their '
    + '*keys* are written by whoever created the object.');
  L.push('');
  L.push('**A count is never a guess.** `forbidden` means the reader account was refused, '
    + '`absent` means the endpoint 404\'d, `unreachable`/`error` mean the read did not '
    + 'happen. Only a number means a page actually came back — and `0` means the server '
    + 'answered and the collection is empty.');
  L.push('');

  L.push('## 1. Totals');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---:|');
  L.push(`| API groups | ${summary.groups} |`);
  L.push(`| Resource types | ${summary.resources} |`);
  L.push(`| — listable | ${summary.listable} |`);
  L.push(`| — namespaced | ${summary.namespaced} |`);
  L.push(`| — cluster-scoped | ${summary.clusterScoped} |`);
  L.push(`| Subresources | ${summary.subresources} |`);
  L.push(`| Probed | ${summary.probed} |`);
  L.push(`| — readable by this account | ${summary.readable} |`);
  L.push(`| — refused (RBAC) | ${summary.refused} |`);
  L.push(`| — read failed | ${summary.failed} |`);
  L.push(`| — readable and non-empty | ${summary.nonEmpty} |`);
  L.push(`| Live objects counted | ${summary.objects.toLocaleString('en-US')} |`);
  L.push('');

  L.push('## 2. Dashboard domains');
  L.push('');
  L.push('Each domain is one candidate section of the console. `Non-empty` is the count of '
    + 'types in it that actually hold objects on this cluster — a domain where that is `0` '
    + 'is a section that would render blank here, however many types it advertises.');
  L.push('');
  L.push('| Domain | Types | Readable | Non-empty | Objects |');
  L.push('|---|---:|---:|---:|---:|');
  for (const d of domains) {
    const s = summarise(d.resources);
    L.push(`| ${fence(d.domain)} | ${s.resources} | ${s.readable} | ${s.nonEmpty} | ${s.objects.toLocaleString('en-US')} |`);
  }
  L.push('');

  L.push('## 3. Where the objects are');
  L.push('');
  L.push('The twenty largest collections on this cluster. A panel over anything in this list '
    + 'needs a page size and a virtualised table; a panel over a type absent from it can '
    + 'render the whole collection.');
  L.push('');
  L.push('| Kind | apiVersion | Objects | Scope |');
  L.push('|---|---|---:|---|');
  for (const e of entries
    .filter(e => e.probe && e.probe.outcome === 'ok' && e.probe.count > 0)
    .sort((a, b) => b.probe.count - a.probe.count)
    .slice(0, 20)) {
    L.push(`| \`${fence(e.kind || e.resource)}\` | \`${fence(e.apiVersion)}\` | ${e.probe.count.toLocaleString('en-US')} | ${e.scope === 'Namespaced' ? 'ns' : 'cluster'} |`);
  }
  L.push('');

  const advertisedEmpty = entries.filter(e => e.probe && e.probe.outcome === 'ok' && e.probe.count === 0);
  L.push(`## 4. Advertised, readable, and empty (${advertisedEmpty.length})`);
  L.push('');
  L.push('These types exist and the account can read them, and there is nothing to show. A '
    + 'panel built for one of these renders an honest empty state **on this cluster** — '
    + 'which is not the same as the type being useless, since another cluster in the fleet '
    + 'may well populate it. Worth knowing before designing a screen around one.');
  L.push('');
  L.push(advertisedEmpty.map(e => `\`${e.kind || e.resource}\``).join(', ') || '_none_');
  L.push('');

  L.push('## 5. Every resource, by domain');
  L.push('');
  domains.forEach((d, i) => {
    L.push(`### 5.${i + 1} ${d.domain}`);
    L.push('');
    L.push('| Kind | apiVersion | Scope | Count | Verbs | Subresources | Command |');
    L.push('|---|---|---|---:|---|---|---|');
    for (const e of d.resources) {
      const verbs = e.verbs.filter(v => ['get', 'list', 'watch'].includes(v)).join(' ') || '—';
      const subs = e.subresources.length ? e.subresources.map(s => `\`${s.name}\``).join(' ') : '—';
      const pref = e.preferred ? '' : ' *(non-preferred)*';
      L.push(`| \`${fence(e.kind || e.resource)}\`${pref} | \`${fence(e.apiVersion)}\` | ${e.scope === 'Namespaced' ? 'ns' : 'cluster'} `
        + `| ${countCell(e)} | ${verbs} | ${subs} | \`${fence(e.kubectl)}\` |`);
    }
    L.push('');
  });

  const nonEmpty = entries
    .filter(e => e.fields && e.fields.length && e.probe && e.probe.count > 0)
    .sort((a, b) => b.probe.count - a.probe.count);

  L.push('## 6. Field shapes of the resources that hold objects');
  L.push('');
  L.push('Paths and types from one sampled object per Kind, `metadata.*` omitted (it is '
    + 'uniform) and `managedFields` dropped. This is what a panel can bind to. Read it as a '
    + 'lower bound: a field absent from the sampled object is absent from this list, not '
    + 'absent from the type.');
  L.push('');
  for (const e of nonEmpty) {
    const paths = e.fields
      .filter(f => !f.path.startsWith('metadata'))
      .filter(f => f.path.split('.').length <= 3)
      .slice(0, 60);
    if (!paths.length) continue;
    L.push(`<details><summary><code>${e.kind || e.resource}</code> — <code>${e.apiVersion}</code>, ${e.probe.count.toLocaleString('en-US')} objects</summary>`);
    L.push('');
    L.push('```');
    for (const f of paths) L.push(`${f.path.padEnd(48)} ${f.type}`);
    L.push('```');
    L.push('');
    L.push('</details>');
    L.push('');
  }

  const refused = entries.filter(e => e.probe && e.probe.outcome === 'forbidden');
  L.push('## 7. Advertised but not readable by this account');
  L.push('');
  if (!refused.length) {
    L.push('None — every listable type the API server advertises was readable.');
  } else {
    L.push('These types exist on the cluster and the account was refused. A dashboard must '
      + 'render them as *unavailable*, never as empty.');
    L.push('');
    L.push('| Kind | apiVersion | Reason |');
    L.push('|---|---|---|');
    for (const e of refused) {
      L.push(`| \`${fence(e.kind || e.resource)}\` | \`${fence(e.apiVersion)}\` | ${fence((e.probe.message || '').slice(0, 300))} |`);
    }
  }
  L.push('');

  const failed = entries.filter(e => e.probe && (e.probe.outcome === 'error' || e.probe.outcome === 'unreachable' || e.probe.outcome === 'absent'));
  if (failed.length) {
    L.push('## 8. Reads that did not complete');
    L.push('');
    L.push('| Kind | apiVersion | Outcome | Detail |');
    L.push('|---|---|---|---|');
    for (const e of failed) {
      L.push(`| \`${fence(e.kind || e.resource)}\` | \`${fence(e.apiVersion)}\` | ${e.probe.outcome} | ${fence((e.probe.message || '').slice(0, 300))} |`);
    }
    L.push('');
  }

  return L.join('\n') + '\n';
}

/* ----------------------------------------------------------------------------- main */

async function main(argv) {
  const flags = parseArgs(argv);
  const { cluster, token, context } = resolveTarget(flags);
  const quiet = Boolean(flags.quiet);
  const say = msg => { if (!quiet) process.stderr.write(`${msg}\n`); };
  const namespace = flags.namespace || null;
  const sample = flags.sample !== false;

  const outMd = path.resolve(flags.out || DEFAULT_OUT);
  const outJson = path.resolve(flags.json || outMd.replace(/\.md$/, '.json'));

  say(`[inventory] ${cluster.apiUrl}${context ? ` (context ${context})` : ''}`);

  const version = await call({ cluster, token, path: '/version' }).catch(() => null);
  // `SelfSubjectReview` would name the account exactly, but it is a POST, and this tool
  // does not POST. The token's own subject claim says the same thing without a request.
  const identity = subjectOf(token);

  const { mode, entries } = await discover({ cluster, token });
  say(`[inventory] discovery: ${mode} — ${entries.length} resource types`);

  const targets = entries.filter(e => e.listable);
  if (flags.probe !== false) {
    let done = 0;
    await pool(targets, Number(flags.concurrency) || 8, async e => {
      const result = await probe({ cluster, token, entry: e, namespace, sample });
      Object.assign(e, result);
      done++;
      if (done % 25 === 0) say(`[inventory] probed ${done}/${targets.length}`);
    });
    say(`[inventory] probed ${done}/${targets.length}`);
  }

  const summary = summarise(entries);
  const meta = {
    apiUrl: cluster.apiUrl,
    context,
    identity,
    version: version ? { gitVersion: version.gitVersion, platform: version.platform } : null,
    generatedAt: new Date().toISOString(),
    discoveryMode: mode,
    namespace,
    sampled: sample,
    probed: flags.probe !== false
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify({ meta, summary, resources: entries }, null, 2) + '\n');
  fs.writeFileSync(outMd, renderMarkdown({ meta, entries, summary }));

  say(`[inventory] ${summary.readable}/${summary.probed} readable, ${summary.nonEmpty} non-empty, `
    + `${summary.objects.toLocaleString('en-US')} objects`);
  say(`[inventory] wrote ${path.relative(process.cwd(), outMd)} and ${path.relative(process.cwd(), outJson)}`);
}

/**
 * The `sub` claim of a JWT, for the document's "Identity" row.
 *
 * Decode only — the signature is the API server's business, and this is a label in a
 * report, not an authorization decision. Any parse failure yields null rather than
 * throwing: not knowing the account's name is no reason to abandon the inventory.
 */
function subjectOf(token) {
  try {
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.sub || null;
  } catch { return null; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`[inventory] ${err.message}\n`);
    process.exit(1);
  });
}

export default { parseArgs, resolveTarget, discover, probe, renderMarkdown, subjectOf, main };
