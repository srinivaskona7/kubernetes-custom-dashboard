/**
 * The development server.
 *
 * `npm run fleet:dev` starts the fleet API on :8099 with no authentication, which is what
 * `app/fleet-ui`'s Vite proxy points at. It mounts the *production* router over the
 * *production* collectors over the *production* k8s client: every read is a real HTTPS call
 * to a real cluster. There is no fixture mode and no baked cluster list — you add a cluster
 * in the UI with its API URL and a fleet-reader token, exactly as you would in a deployment.
 *
 * The token stays in this process's memory and is written nowhere; restarting the server
 * forgets it. What differs from production is authentication and persistence, nothing about
 * the data: a number on the screen here came off a cluster.
 *
 * It refuses to start with NODE_ENV=production. Nothing about this file belongs in a
 * cluster, and the one way it could cause harm is by being started there by accident.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import registryModule from './registry.js';
const { Registry } = registryModule;
import renewerModule from './renewer.js';
const { Renewer } = renewerModule;
import tokensModule from './tokens.js';
const { TokenStore } = tokensModule;
import secretWriterModule from './secret-writer.js';
const { SecretTokenWriter } = secretWriterModule;
import fleetRouter from './router.js';
import jsonBoundary from './json-boundary.js';

if (process.env.NODE_ENV === 'production') {
  console.error('[fleet:dev] FATAL: the development server serves without auth; refusing to start in production');
  process.exit(1);
}

const PORT = Number(process.env.FLEET_DEV_PORT) || 8099;

// A scratch directory standing in for the image's baked list and the projected mount of
// onboarded clusters. Using real files rather than an injected cluster array means the
// registry does its real merge — baked wins over onboarded — in development too. The baked
// list starts empty: there is no such thing as a cluster this harness already knows about.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dev-'));
const clustersFile = path.join(workDir, 'clusters.json');
const clustersDir = path.join(workDir, 'onboarded');
fs.writeFileSync(clustersFile, JSON.stringify({ clusters: [] }, null, 2));
fs.mkdirSync(clustersDir);

const registry = new Registry({ file: clustersFile, dir: clustersDir });

// The production TokenStore and the production SecretTokenWriter. Off-cluster there is no
// service-account mount, so the writer's Secret sync is skipped and its records live in the
// in-process store — which is exactly where TokenStore.read() looks next (`memTokens`), and
// Registry merges `memClusters` the same way. So an onboarded cluster and its pasted token
// are honoured end to end, and nothing is persisted to disk.
const tokens = new TokenStore();
const tokenWriter = new SecretTokenWriter({ secretName: 'fleet-dashboard-tokens' });
const clusterWriter = new SecretTokenWriter({ secretName: 'fleet-dashboard-clusters' });

const renewer = new Renewer({
  registry,
  writer: tokenWriter,
  // Short enough to watch happen. The renewal threshold is still half-life, so most sweeps
  // are a no-op — which is exactly what the Renewal clock card should show.
  intervalMs: 60_000,
  startupDelayMs: 2000
}).start();

const app = express();
app.use(express.json({ limit: '512kb' }));

// No auth middleware at all: /me answers with a fixed development identity so the UI's
// capability flags have something to read.
app.use(fleetRouter.MOUNT_PATH, (req, _res, next) => {
  req.user = { id: 'dev@localhost', name: 'Development User', scopes: [] };
  next();
});

// No transport overrides. The collectors fall through to the real k8s client — the same code
// path production takes, which is the only reason reviewing a feature here proves anything.
app.use(
  fleetRouter.MOUNT_PATH,
  fleetRouter.createRouter({ registry, tokens, tokenWriter, clusterWriter, renewer })
);

// The same JSON boundary production mounts in server/index.js. Without it this dev server
// answered an unmatched path with Express's HTML 404 while production answered JSON — so the
// harness used to verify the HTML-leak fix did not reproduce the bug being fixed.
jsonBoundary.mountJsonBoundary(app, fleetRouter.MOUNT_PATH);

app.listen(PORT, () => {
  console.log(`[fleet:dev] LIVE (real clusters) on http://localhost:${PORT}${fleetRouter.MOUNT_PATH}`);
  console.log(`[fleet:dev] clusters: ${registry.all().map(c => c.id).join(', ') || '(none — add one in the UI)'}`);
  console.log('[fleet:dev] every read is a real HTTPS call; the token you paste stays in memory and is lost on restart');
});
