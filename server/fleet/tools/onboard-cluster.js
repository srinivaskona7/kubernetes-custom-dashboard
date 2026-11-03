#!/usr/bin/env node
/**
 * Onboard one managed cluster, end to end, from an administrator's workstation.
 *
 *   npm run fleet:onboard -- --target platformsbx --id platformsbx --env sbx \
 *                            --hub appkymadv --hub-namespace btp-platform-foundation
 *
 * This exists because the deploy pipeline is not permitted to create Roles or
 * RoleBindings. Every privileged step therefore has to happen under a human's own
 * credential, once, out of band — and once it has, the dashboard picks the cluster up on
 * its own. There is no UI step and nothing to paste.
 *
 * What it does, in order:
 *
 *   1. target  apply cluster-rbac/fleet-reader.yaml — namespace, service account,
 *              read-only ClusterRole, and the self-mint Role that lets the chain turn
 *   2. target  read apiUrl and CA out of the kubeconfig, then mint the first token
 *   3. target  PROVE it: the token must authenticate, and the account must be allowed to
 *              mint its own successor. A cluster that fails here would have gone dark in
 *              24 hours with nobody watching
 *   4. hub     patch the two Secrets the srv pod mounts
 *
 * Then kubelet refreshes both projected volumes within about a minute, `registry.js`
 * scans the new cluster file and `tokens.js` finds its token — on every replica, with no
 * restart. `renewer.js` takes it from there and renews at half-life indefinitely.
 *
 * The records written in step 4 are byte-identical in shape to what the application
 * writes for a UI-onboarded cluster, so the reader side learns nothing new.
 *
 *   --target <ctx>        kubectl context for the cluster being onboarded  (required)
 *   --id <id>             cluster id; also the Secret key and token filename (required)
 *   --hub <ctx>           kubectl context for the cluster the dashboard runs on (required)
 *   --hub-namespace <ns>  release namespace on the hub  (default btp-platform-foundation)
 *   --name "<text>"       display name                  (default: the id)
 *   --env <env>           sbx | dev | uat | prod        (default unknown)
 *   --duration <d>        first token lifetime          (default 24h)
 *   --dry-run             print every command and every record, change nothing
 *
 * Object names default to fleet-dashboard / fleet-reader / fleet-dashboard-reader and are all
 * overridable, because a cluster's owner may have a naming convention:
 *
 *   --prefix <p>          renames the RBAC objects together: <p>-reader,
 *                         <p>-token-issuer
 *   --namespace <ns>      namespace holding the service account   (default fleet-dashboard)
 *   --sa <name>           the service account itself              (default fleet-reader)
 *
 * With any of those set the bundle is generated from print-rbac.js and applied over
 * stdin, rather than reading the committed cluster-rbac/*.yaml — same generator either
 * way, so renaming cannot make the applied rules diverge from the reviewed ones. The
 * chosen namespace and service account are written into the cluster record, so the
 * collectors and the renewer look in the right place.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import clusterInputModule from './cluster-input.js';
const { readCluster } = clusterInputModule;
import printRbacModule from './print-rbac.js';
const { render, resolveNames } = printRbacModule;
import saTokenModule from '../sa-token.js';
const { decode } = saTokenModule;
import onboardModule from '../onboard.js';
const { FIRST_TOKEN_SECONDS } = onboardModule;
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DURATION = `${FIRST_TOKEN_SECONDS / 3600}h`;
const DEFAULT_HUB_NAMESPACE = 'btp-platform-foundation';
const TOKENS_SECRET = 'fleet-dashboard-tokens';
const CLUSTERS_SECRET = 'fleet-dashboard-clusters';
/** Same rule the registry enforces. The id becomes a filename, so a bad one is traversal. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function kubectl(args, input) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The cluster record the registry reads out of FLEET_CLUSTERS_DIR.
 * Field names match `registry.js` validate() exactly — see the Cluster typedef there.
 */
function clusterRecord({ id, name, env, apiUrl, caData, by, at, namespace, serviceAccount }) {
  // Defaulted rather than required: an undefined namespace here would be written into the
  // Secret and every collector would then look in the wrong place, silently.
  const names = resolveNames({ namespace, serviceAccount });
  return {
    id,
    displayName: name || id,
    env: env || 'unknown',
    apiUrl,
    caData,
    // Carried per cluster, not assumed: the registry reads these back, so a cluster
    // onboarded under a custom naming convention is still found by the collectors.
    namespace: names.namespace,
    serviceAccount: names.serviceAccount,
    enabled: true,
    source: 'onboarded',
    onboardedAt: at,
    onboardedBy: by,
  };
}

/**
 * The token record the token store reads out of FLEET_TOKENS_PATH.
 * `renewedAt` is null because this is the first token, not a renewal — the renewer sets it.
 */
function tokenRecord({ token, expiresAt }) {
  return { token, expiresAt, renewedAt: null, lastError: null };
}

/** A strategic merge patch touching exactly one key, so other clusters are never disturbed. */
function patchArgs({ hub, namespace, secret, key, value }) {
  const data = { data: { [key]: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') } };
  return ['--context', hub, '-n', namespace, 'patch', 'secret', secret, '--type', 'merge', '-p', JSON.stringify(data)];
}

/**
 * Run the whole thing.
 *
 * Every external effect goes through `runFn`, so a test drives the full sequence — the
 * exact argv of every kubectl call, and both records — without a cluster and without
 * minting anything. That is the same seam every other module in server/fleet takes.
 *
 * @param {object} args
 * @param {Function} [args.runFn]  injection seam; receives an argv array
 * @param {Function} [args.logFn]
 * @param {() => string} [args.nowFn]
 */
function onboard({
  target, id, hub, hubNamespace = DEFAULT_HUB_NAMESPACE, name, env,
  duration = DEFAULT_DURATION, dryRun = false,
  prefix, namespace, serviceAccount,
  runFn = kubectl, logFn = console.error, nowFn = () => new Date().toISOString(),
}) {
  const names = resolveNames({ prefix, namespace, serviceAccount });
  const custom = Boolean(prefix || namespace || serviceAccount);
  for (const [flagName, value] of [['--target', target], ['--id', id], ['--hub', hub]]) {
    if (!value) throw new Error(`${flagName} is required`);
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`--id must match ${ID_PATTERN} — it becomes a filename in the token mount (got ${JSON.stringify(id)})`);
  }
  if (target === hub) {
    // Not fatal, but almost always a mistake, and the baked entry would win anyway.
    logFn(`[onboard] warning: --target and --hub are both "${hub}"; a baked cluster always beats an onboarded one`);
  }

  const run = (argv, input) => {
    if (dryRun) {
      logFn(`  DRY-RUN kubectl ${argv.join(' ')}${input ? ' <<< (generated manifest)' : ''}`);
      return '';
    }
    return runFn(argv, input);
  };
  const step = (n, msg) => logFn(`[onboard] ${n}/4 ${msg}`);

  // ---- 1. the grant, under the administrator's own credential -----------------------
  const bundle = 'fleet-dashboard-rbac.yaml';
  if (custom) {
    // Generated on the fly from the same function that produced the committed bundle, so
    // renaming cannot make the applied rules diverge from the reviewed ones.
    step(1, `applying generated RBAC to ${target} (ns=${names.namespace}, sa=${names.serviceAccount}, role=${names.clusterRole})`);
    run(['--context', target, 'apply', '-f', '-'], render({ names }));
  } else {
    step(1, `applying ${bundle} to ${target}`);
    run(['--context', target, 'apply', '-f', path.join(REPO, bundle)]);
  }

  // ---- 2. identity and first token --------------------------------------------------
  step(2, `reading the API address and CA from context ${target}`);
  const { apiUrl, caData } = readCluster({ context: target, runFn });

  const token = dryRun
    ? 'eyJdry.eyJrun.signature'
    : runFn(['--context', target, 'create', 'token', names.serviceAccount, '-n', names.namespace, `--duration=${duration}`]);
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new Error('kubectl did not return a service-account token — did step 1 apply cleanly?');
  }

  // The expiry comes off the token itself rather than from `--duration`. The API server is
  // free to clamp a requested lifetime, and a record that claims 24h against a token the
  // cluster capped at 1h would have the renewer sleeping straight through the expiry.
  let expiresAt;
  if (dryRun) {
    expiresAt = new Date(Date.parse(nowFn()) + FIRST_TOKEN_SECONDS * 1000).toISOString();
  } else {
    const claims = decode(token);
    expiresAt = new Date(claims.expiresAt || claims.exp * 1000).toISOString();
  }
  step(2, `token minted, expires ${expiresAt}`);

  // ---- 3. prove it, before anything is written --------------------------------------
  step(3, 'verifying the token authenticates and can mint its successor');
  const canMint = run([
    '--context', target, 'auth', 'can-i', 'create',
    '--subresource=token', `serviceaccounts/${names.serviceAccount}`, '-n', names.namespace,
  ]);
  if (!dryRun && canMint.trim() !== 'yes') {
    throw new Error(
      `${names.serviceAccount} cannot mint its own successor on ${target}, so the renewal chain would ` +
      `stop after this token. Re-apply ${bundle} and check the token-issuer Role.`
    );
  }

  // ---- 4. hand it to the hub ---------------------------------------------------------
  const at = nowFn();
  const by = process.env.USER || process.env.LOGNAME || 'admin-script';
  const cluster = clusterRecord({
    id, name, env, apiUrl, caData, by, at,
    namespace: names.namespace, serviceAccount: names.serviceAccount,
  });
  const tokens = tokenRecord({ token, expiresAt });

  step(4, `writing ${id} into ${CLUSTERS_SECRET} and ${TOKENS_SECRET} on ${hub}/${hubNamespace}`);
  run(patchArgs({ hub, namespace: hubNamespace, secret: CLUSTERS_SECRET, key: id, value: cluster }));
  run(patchArgs({ hub, namespace: hubNamespace, secret: TOKENS_SECRET, key: id, value: tokens }));

  logFn(
    `[onboard] done — ${id} (${apiUrl}) will appear in the dashboard within about a minute, ` +
    `once kubelet refreshes the projected volumes. No restart needed.`
  );
  return { cluster, tokens, expiresAt };
}

function flag(argv, key) {
  const i = argv.indexOf(`--${key}`);
  return i === -1 ? undefined : argv[i + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    onboard({
      target: flag(process.argv, 'target'),
      id: flag(process.argv, 'id'),
      hub: flag(process.argv, 'hub'),
      hubNamespace: flag(process.argv, 'hub-namespace'),
      name: flag(process.argv, 'name'),
      env: flag(process.argv, 'env'),
      duration: flag(process.argv, 'duration'),
      dryRun: process.argv.includes('--dry-run'),
      prefix: flag(process.argv, 'prefix'),
      namespace: flag(process.argv, 'namespace'),
      serviceAccount: flag(process.argv, 'sa'),
    });
  } catch (err) {
    console.error(`[onboard] ${err.message}`);
    process.exit(1);
  }
}

export default { onboard, clusterRecord, tokenRecord, patchArgs, DEFAULT_HUB_NAMESPACE };
