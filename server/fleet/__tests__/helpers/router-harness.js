
/**
 * A router-level test harness: the production Express router, mounted for real, answering
 * real HTTP requests over a real socket.
 *
 * Every test in test/fleet/ before this one drove a collector or a helper function
 * directly. None of them mounted `createRouter` itself, which is how a `ReferenceError`
 * inside a route handler shipped: `wrap()` catches it, the error middleware has no code
 * path for a bare `Error`, and the response is a 500 that no test ever sent a request to
 * see. Testing at the router layer is the only way to catch that class of bug — a
 * duplicate route registration, an error type the middleware doesn't handle, a seam a
 * route forgot to thread through — because those bugs live in the wiring, not in any one
 * collector.
 *
 * This mirrors srv/fleet/dev-server.js on purpose: same Registry-over-temp-dir
 * construction, same test/fleet/dev-fixtures.js transport. A shape that appears here is a
 * shape `npm run fleet:dev` would also produce, and a shape the real collectors actually
 * emit — nothing here is a hand-written response fixture that could drift from them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import _registry from '../../registry.js';
const { Registry } = _registry;
import fleetRouter from '../../router.js';
import fixtures from '../dev-fixtures.js';

/**
 * Two clusters, not one: the same BAKED_IDS dev-server.js uses. One cluster is not enough
 * to catch a bug where a fleet-wide route (`/workloads`, `/compliance`, ...) accidentally
 * hard-codes "the first cluster" instead of aggregating, and `demo-dev`'s scenario is a
 * crash-looping deployment — the unhappy path every collector has to survive.
 */
const DEFAULT_CLUSTER_IDS = ['platformsbx', 'demo-dev'];
const DEFAULT_CLUSTERS = DEFAULT_CLUSTER_IDS.map(id => ({
  id,
  displayName: id === 'platformsbx' ? 'Platform SBX' : 'Kyma Dev',
  env: id === 'platformsbx' ? 'sbx' : 'dev',
  apiUrl: id === 'platformsbx' ? 'https://kubernetes.default.svc' : `https://api.${id}.invalid`,
  enabled: true
}));

/**
 * Mount the real router over a disposable fixture registry, serve it on an ephemeral port,
 * and hand the caller a tiny HTTP client — then tear down unconditionally.
 *
 * The registry is backed by real files in a real temp directory rather than
 * `new Registry({ clusters: [...] })`, because the latter bypasses `_loadFile()` /
 * `_scanDir()` entirely. This project's actual failure mode was a wiring bug that only a
 * request over a socket, against the real construction path, would ever exercise — using
 * the shortcut constructor here would repeat the same mistake at one layer down.
 *
 * @param {object} [overrides] shallow-merged over the seam defaults passed to createRouter.
 *        Pass `tokens`, `listFn`, `textFn`, `callFn`, `tokenWriter`, `clusterWriter`,
 *        `renewer`, or `cache` to replace any one of them for a single test.
 * @param {(ctx: {
 *   baseUrl: string,
 *   get: (path: string, init?: object) => Promise<{status: number, contentType: string, body: any}>,
 *   registry: import('../../../srv/fleet/registry').Registry,
 *   router: import('express').Router,
 *   app: import('express').Express
 * }) => Promise<void>|void} fn
 */
async function withRouter(overrides, fn) {
  if (typeof overrides === 'function') {
    fn = overrides;
    overrides = {};
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-router-test-'));
  const clustersFile = path.join(workDir, 'clusters.json');
  const clustersDir = path.join(workDir, 'onboarded');
  fs.writeFileSync(clustersFile, JSON.stringify({ clusters: DEFAULT_CLUSTERS }, null, 2));
  fs.mkdirSync(clustersDir);

  const registry = new Registry({ file: clustersFile, dir: clustersDir });

  const deps = {
    registry,
    tokens: fixtures.createTokenStore(),
    listFn: fixtures.listFn,
    textFn: fixtures.textFn,
    callFn: fixtures.callFn,
    ...overrides
  };

  const app = express();
  app.use(express.json({ limit: '512kb' }));
  // No auth middleware: every route under test gets a fixed identity, the same way
  // dev-server.js does it. Auth itself is srv/fleet/auth.js's problem, covered by
  // auth.test.js — this harness exists to test what happens after auth succeeds.
  app.use(fleetRouter.MOUNT_PATH, (req, _res, next) => {
    // `x-test-user` lets a single test drive two identities against one router, which is what
    // the OIDC flow-ownership check needs: the leg that starts a flow and the leg that finishes
    // it are separate requests, and the whole point is that they can differ. `anonymous` maps to
    // no `req.user` at all, the shape `FLEET_AUTH=none` produces.
    const asUser = req.get('x-test-user');
    if (asUser === 'anonymous') req.user = undefined;
    else req.user = { id: asUser || 'router-test@localhost', name: 'Router Test', scopes: [] };
    next();
  });

  const router = fleetRouter.createRouter(deps);
  app.use(fleetRouter.MOUNT_PATH, router);

  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0);
      s.once('listening', () => resolve(s));
      s.once('error', reject);
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}${fleetRouter.MOUNT_PATH}`;

    const get = async (reqPath, init) => {
      const res = await fetch(`${baseUrl}${reqPath}`, init);
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      let body = text;
      if (contentType.includes('json')) {
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          // A route claiming Content-Type: json but sending unparsable text is itself a
          // bug worth a loud test failure, not a silent fallback to the raw string.
          throw new Error(`${reqPath} answered content-type ${contentType} with unparseable body: ${text.slice(0, 200)}`);
        }
      }
      return { status: res.status, contentType, body };
    };

    await fn({ baseUrl, get, registry, router, app });
  } finally {
    if (server) {
      await new Promise(resolve => {
        server.close(resolve);
        // fetch() keeps its HTTP connection alive by default; server.close() waits for
        // every open connection to end on its own, which a keep-alive socket never does.
        // Without this a failing assertion doesn't just fail — it hangs the test runner.
        server.closeAllConnections();
      });
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Every `{method, path}` pair the router answers to, in registration order, including any
 * duplicate — a duplicate is exactly the bug the caller is likely checking for, so this
 * does not deduplicate on the caller's behalf.
 *
 * Express keeps the routes actually reachable from any given `express.Router()` on its own
 * `.stack`. Non-route layers (a plain `router.use()` logger, the trailing error handler)
 * have no `.route` and are skipped; everything else in this router is a real endpoint.
 *
 * @param {import('express').Router} router the object `createRouter()` returned
 * @returns {{method: string, path: string}[]}
 */
function listRoutes(router) {
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) routes.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return routes;
}

/**
 * Fill an Express path template's `:param` segments from a values map.
 *
 * A naive `.replace(':name', ...)` breaks on this router's own routes: ':name' is a
 * prefix of ':namespace', so replacing ':name' first would corrupt
 * '/clusters/:id/workloads/:namespace/:name/rollout' by matching inside ':namespace'
 * rather than at the later, distinct ':name' segment. Splitting on '/' and matching whole
 * segments sidesteps that entirely.
 *
 * @param {string} template e.g. '/clusters/:id/workloads/:namespace/:name/rollout'
 * @param {Record<string, string>} values
 */
function fillPath(template, values) {
  return template
    .split('/')
    .map(segment => {
      if (!segment.startsWith(':')) return segment;
      const key = segment.slice(1);
      if (!(key in values)) throw new Error(`no fixture value supplied for path param :${key} in ${template}`);
      return encodeURIComponent(values[key]);
    })
    .join('/');
}

/**
 * Hit every unique GET route the router registers, substituting real ids discovered from
 * the running server's own responses rather than from fixture internals this harness has
 * no business knowing about. A path registered more than once is requested only once —
 * both registrations would answer identically (Express matches the first and the rest
 * shadow it), so a second request would test nothing new; a route inventory test is the
 * right place to flag the duplicate itself.
 *
 * @param {object} args
 * @param {import('express').Router} args.router
 * @param {(path: string) => Promise<{status: number, contentType: string, body: any}>} args.get
 * @param {import('../../../srv/fleet/registry').Registry} args.registry
 * @returns {Promise<Array<{method: string, path: string, resolved: string, status: number, contentType: string, body: any}>>}
 */
async function sweepGetRoutes({ router, get, registry }) {
  const [firstCluster] = registry.active();
  if (!firstCluster) throw new Error('sweepGetRoutes needs at least one active cluster in the registry');
  const clusterId = firstCluster.id;

  // Discovered from the router's own answers, not hard-coded against dev-fixtures.js's
  // scenario tables — those are somebody else's file to change, and this sweep should keep
  // working whatever shape they take, same as a real UI would.
  const workloadsRes = await get(`/clusters/${encodeURIComponent(clusterId)}/workloads`);
  const firstWorkload = (workloadsRes.body && workloadsRes.body.data && workloadsRes.body.data.items && workloadsRes.body.data.items[0])
    || (workloadsRes.body && workloadsRes.body.items && workloadsRes.body.items[0])
    || {};
  const namespace = firstWorkload.namespace || 'btp-platform-foundation';
  const name = firstWorkload.name || 'api';

  const podsRes = await get(`/clusters/${encodeURIComponent(clusterId)}/pods`);
  const firstPod = (podsRes.body && podsRes.body.data && podsRes.body.data.items && podsRes.body.data.items[0])
    || (podsRes.body && podsRes.body.items && podsRes.body.items[0])
    || {};
  const podNamespace = firstPod.namespace || namespace;
  const podName = firstPod.name || 'api-0';
  const firstContainer = (firstPod.containers && firstPod.containers[0] && firstPod.containers[0].name) || 'api';

  // `kind` comes from the same discovered workload as `namespace`/`name`, so the graph route
  // is swept against a workload that actually exists rather than a guessed kind — an
  // unsupported kind is rejected with a 400 before any collector runs, which would make the
  // sweep pass without ever exercising the route.
  const kind = firstWorkload.kind || 'Deployment';

  // Same discipline as `namespace`/`name`/`kind`: the OPA YAML route's `:template` is a
  // ConstraintTemplate name, discovered from the router's own OPA answer. The fallback matters
  // because a cluster with no Gatekeeper answers with an empty policy list, and the sweep still
  // has to exercise the route — with a name that does not exist it must answer a typed 404, which
  // is exactly the assertion this sweep makes.
  const opaRes = await get(`/clusters/${encodeURIComponent(clusterId)}/opa`);
  const firstPolicy = (opaRes.body && opaRes.body.data && opaRes.body.data.policies
    && opaRes.body.data.policies[0]) || {};
  const template = firstPolicy.templateName || 'k8srequiredlabels';

  // And the same again for `:traceId`. A trace id is discovered from the router's own traces
  // answer, because the window is a *log tail* and no fixture can promise one: a cluster whose
  // access log is off, or streamed off the pod, correlates nothing at all. The fallback is a
  // well-formed id that is deliberately not in the window, so the sweep then asserts the route
  // answers a typed body rather than a 500 — which is the case that actually breaks.
  const tracesRes = await get(`/clusters/${encodeURIComponent(clusterId)}/traces`);
  const firstTrace = (tracesRes.body && tracesRes.body.data && tracesRes.body.data.traces
    && tracesRes.body.data.traces[0]) || {};
  const traceId = firstTrace.traceId || '00000000000000000000000000000001';

  const values = { id: clusterId, namespace, name, kind, template, traceId };
  const queryFor = routePath => {
    if (routePath === '/clusters/:id/logs') {
      return `?${new URLSearchParams({ namespace: podNamespace, pod: podName, container: firstContainer })}`;
    }
    return '';
  };

  const seenPaths = new Set();
  const results = [];
  for (const route of listRoutes(router)) {
    if (route.method !== 'GET') continue;
    if (seenPaths.has(route.path)) continue;
    seenPaths.add(route.path);

    const resolvedPath = fillPath(route.path, values) + queryFor(route.path);
    const response = await get(resolvedPath);
    results.push({ method: route.method, path: route.path, resolved: resolvedPath, ...response });
  }
  return results;
}

export default {
  withRouter,
  listRoutes,
  fillPath,
  sweepGetRoutes,
  DEFAULT_CLUSTER_IDS,
  DEFAULT_CLUSTERS
};
