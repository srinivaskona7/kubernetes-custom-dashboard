#!/usr/bin/env node
/**
 * Build the cluster-input file for one cluster.
 *
 *   node server/fleet/tools/cluster-input.js --name "Platform Dev" --env dev \
 *     > ~/Downloads/kyma-fleet-platform-dev.json
 *
 * The file it writes is not a new format: it is exactly the body of
 * `POST /api/fleet/clusters`, so the same four values can be pasted into the dialog,
 * dropped on it as a file, or curl'd. One contract, three ways to deliver it — a
 * separate descriptor format would be a fourth thing to keep in step with the API.
 *
 * Everything except the display name is read out of the current kubectl context, because
 * every one of those values is a fact about the cluster that the operator would otherwise
 * copy by hand from `kubectl config view` and could get wrong silently. The token is the
 * exception: it is *minted*, by the operator's own credential, and that is the one line
 * here that changes anything on the cluster.
 *
 *   --context <name>   read a context other than the current one
 *   --duration <d>     token lifetime; default 24h, which is what the chain assumes
 *
 * It refuses to write to stdout if stdout is a TTY. The output contains a live
 * credential, and a token scrolled into terminal history is a token in a log somewhere.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import onboardModule from '../onboard.js';
const { FIRST_TOKEN_SECONDS, FLEET_NAMESPACE, FLEET_SA } = onboardModule;
import { fileURLToPath } from 'node:url';

/** The default duration, expressed the way `kubectl create token` wants it. */
const DEFAULT_DURATION = `${FIRST_TOKEN_SECONDS / 3600}h`;

function kubectl(args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Read the cluster's identity out of a kubeconfig context.
 *
 * `--minify` is what makes this safe to run against a kubeconfig holding twenty clusters:
 * it reduces the view to the one context in play, so `.clusters[0]` is unambiguous rather
 * than whichever cluster happens to sort first.
 *
 * @param {object} [opts]
 * @param {string} [opts.context]
 * @param {typeof kubectl} [opts.runFn] injection seam
 */
function readCluster({ context, runFn = kubectl } = {}) {
  const where = context ? ['--context', context] : [];
  const view = field => runFn(['config', 'view', '--raw', '--minify', ...where, '-o', `jsonpath={.clusters[0].cluster.${field}}`]);

  const apiUrl = view('server');
  if (!/^https:\/\//.test(apiUrl)) {
    throw new Error(`context ${context || '(current)'} has no https server address (got ${JSON.stringify(apiUrl)})`);
  }

  // A kubeconfig may carry its CA inline as base64, or point at a file on disk. Both are
  // normal; the dashboard needs the PEM either way, so whichever is present is resolved
  // here rather than left for the operator to notice.
  const inline = view('certificate-authority-data');
  const caData = inline
    ? Buffer.from(inline, 'base64').toString('utf8')
    : readFileSync(view('certificate-authority'), 'utf8');

  if (!caData.includes('BEGIN CERTIFICATE')) {
    throw new Error('the resolved certificate authority is not a PEM certificate');
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ''), caData };
}

/**
 * Assemble the input file.
 *
 * Pure but for the two seams, so a test can drive the whole shape without a cluster and
 * without minting anything.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} [args.env]
 * @param {string} [args.context]
 * @param {string} [args.duration]
 * @param {Function} [args.runFn]
 * @param {Function} [args.mintFn] returns the token string
 */
function buildInput({ name, env = 'unknown', context, duration = DEFAULT_DURATION, runFn = kubectl, mintFn }) {
  if (!name || !String(name).trim()) throw new Error('--name is required; it becomes the cluster id');

  const { apiUrl, caData } = readCluster({ context, runFn });
  const mint = mintFn || (() => {
    return runFn([
      'create', 'token', FLEET_SA, '-n', FLEET_NAMESPACE, `--duration=${duration}`,
      ...(context ? ['--context', context] : [])
    ]);
  });

  const token = mint();
  // Structural check only — the server verifies it against the cluster. This catches the
  // one failure that would otherwise write a useless file: the RBAC bundle was never
  // applied, so `kubectl create token` printed an error rather than a token.
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new Error('kubectl did not return a service-account token — has fleet-dashboard-rbac.yaml been applied?');
  }

  return {
    name: String(name).trim(),
    env,
    apiUrl,
    caData,
    token,
  };
}

function flag(argv, key) {
  const i = argv.indexOf(`--${key}`);
  return i === -1 ? undefined : argv[i + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.stdout.isTTY) {
    console.error('[cluster-input] refusing to print a live token to a terminal — redirect to a file:');
    console.error('  node server/fleet/tools/cluster-input.js --name "Platform Dev" --env dev > ~/Downloads/platform-dev.json');
    process.exit(2);
  }
  try {
    const input = buildInput({
      name: flag(process.argv, 'name'),
      env: flag(process.argv, 'env'),
      context: flag(process.argv, 'context'),
      duration: flag(process.argv, 'duration'),
    });
    process.stdout.write(JSON.stringify(input, null, 2) + '\n');
    console.error(`[cluster-input] ${input.name} → ${input.apiUrl} (token minted, expires in ${flag(process.argv, 'duration') || DEFAULT_DURATION})`);
  } catch (err) {
    console.error(`[cluster-input] ${err.message}`);
    process.exit(1);
  }
}

export default { buildInput, readCluster, DEFAULT_DURATION };
