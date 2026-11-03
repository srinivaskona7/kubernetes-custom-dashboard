
/**
 * Router-level tests: mount the real `createRouter()`, over the real Registry
 * construction path, and send real HTTP requests at it.
 *
 * Every other test file in this directory drives a collector, a helper, or a class
 * directly — none of them mount the router. That gap is how a bug reached
 * `GET /api/fleet/report` in production: a route handler referenced a function that did
 * not exist, `wrap()`'s `.catch(next)` turned the `ReferenceError` into a request to the
 * error middleware, and the middleware answered it with a plain 500 — a response no test
 * had ever asked to see, because no test had ever asked the router anything.
 *
 * These tests exist to close that gap generally, not just for `/report`: a route
 * inventory check that catches a path registered twice (the second copy is dead code,
 * silently shadowed by the first), a full sweep of every GET route that fails on any bare
 * 500, and an invariant that no response body ever contains a token value.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';

import _router_harness from './helpers/router-harness.js';
const { withRouter, listRoutes, sweepGetRoutes } = _router_harness;
import fixtures from './dev-fixtures.js';
import _router2 from '../router.js';
const { MOUNT_PATH } = _router2;
import _fanout3 from '../fanout.js';
const { OIDC_FALLBACK_TO_SA } = _fanout3;
import _errors4 from '../errors.js';
const { ClusterError, FORBIDDEN } = _errors4;

const __dirname = import.meta.dirname;

// ------------------------------------------------------------------- route inventory

test('no GET/POST/etc. method+path pair is registered on the router twice', async () => {
  await withRouter(async ({ router }) => {
    const seen = new Map();
    for (const { method, path } of listRoutes(router)) {
      const key = `${method} ${path}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);

    assert.deepStrictEqual(
      duplicates,
      [],
      'a route registered more than once means the second registration is dead code, ' +
        'silently shadowed by the first — Express matches in registration order and never reaches it'
    );
  });
});

// ----------------------------------------------------------------------- GET sweep

test('every GET route answers 2xx or a typed error — never a bare 500', async () => {
  await withRouter(async ({ router, get, registry }) => {
    const results = await sweepGetRoutes({ router, get, registry });

    // A floor, not an exact count: this pins down that the sweep actually walked the
    // router's real route table rather than silently iterating zero routes because
    // `listRoutes()` was pointed at the wrong object.
    assert.ok(
      results.length >= 20,
      `expected to sweep the router's full GET surface (20+ routes); only found ${results.length}: ` +
        results.map(r => r.path).join(', ')
    );

    const bare500s = results.filter(r => r.status === 500);
    assert.deepStrictEqual(
      bare500s.map(r => `${r.method} ${r.resolved} -> 500 ${JSON.stringify(r.body)}`),
      [],
      'a route answered 500 — the router\'s own error middleware only reaches that branch ' +
        'for an error it does not recognise as a typed ClusterError/KubeconfigError/SaTokenError; ' +
        'that is an unhandled bug in the route, not a degraded cluster'
    );

    for (const r of results) {
      // `/report` is the router's one deliberate exception: it sets
      // `Content-Type: text/markdown` and `Content-Disposition: attachment` on success,
      // because it is a downloadable report, not a JSON API response (see router.js's
      // `res.setHeader` calls on that route). Holding it to the same "body is JSON" bar as
      // every other route would make this test fail the moment `/report` starts working,
      // which is the opposite of what a regression test should do.
      if (r.path === '/report' && r.status < 300) {
        assert.ok(!r.contentType.includes('json'), `/report succeeded but answered JSON (${r.contentType}); the markdown-download contract changed`);
        assert.ok(typeof r.body === 'string' && r.body.length > 0, '/report succeeded with an empty body');
        continue;
      }
      assert.ok(
        r.contentType.includes('json'),
        `${r.method} ${r.resolved} answered content-type "${r.contentType}", not JSON (status ${r.status})`
      );
    }
  });
});

// ----------------------------------------------------------------------- token secrecy

test('no GET route response body ever contains a token value', async () => {
  const SENTINEL = 'SENTINEL_TOKEN_VALUE_DO_NOT_LEAK';

  // Wraps the real dev-fixtures token store rather than replacing it outright, so
  // `health()` keeps reporting real statuses (valid/expiring/unseeded) from the real
  // scenario table — only the bearer string itself, the thing that must never reach a
  // response body, is swapped for a value a test can grep for.
  const base = fixtures.createTokenStore();
  const sentinelTokens = {
    adopt: (...args) => base.adopt(...args),
    health: id => base.health(id),
    tokenFor: id => (base.tokenFor(id) ? SENTINEL : null)
  };

  await withRouter({ tokens: sentinelTokens }, async ({ router, get, registry }) => {
    const results = await sweepGetRoutes({ router, get, registry });
    assert.ok(results.length >= 20, `expected the full GET surface, only swept ${results.length}`);

    const leaks = results.filter(r => JSON.stringify(r.body).includes(SENTINEL));
    assert.deepStrictEqual(
      leaks.map(r => `${r.method} ${r.resolved}`),
      [],
      'a route echoed the token store\'s bearer value back into its response body — ' +
        'every route must report facts about a token (status, expiry) and never the token itself'
    );
  });
});

// ------------------------------------------------------------------ /report rendering

/**
 * `/report` renders Markdown, not JSON, so the GET sweep above only proves it stops
 * returning 500 — it cannot see that a field the template interpolates does not exist.
 * It didn't: the compliance collector's summary reports counts (`audited`, `compliant`,
 * `withFindings`) and has never had a `score`, so the template's `summary.score` rendered
 * the literal text "Score undefined%" for every cluster. That defect was invisible for as
 * long as the route 500'd, and became visible the moment it started working.
 *
 * Asserting "no 'undefined' anywhere in the document" is deliberately broader than
 * asserting the score is 75%: it catches the next field somebody interpolates without
 * checking, which is the actual failure mode here.
 */
test('the report never renders undefined, NaN or [object Object] into operator-facing text', async () => {
  await withRouter(async ({ get }) => {
    const res = await get('/report');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/markdown/);

    for (const rendered of ['undefined', 'NaN', '[object Object]']) {
      assert.ok(
        !res.body.includes(rendered),
        `the report rendered "${rendered}" into the document a human reads:\n${res.body}`
      );
    }
  });
});

test('the compliance score carries its denominator, and an empty cluster is not 100%', async () => {
  await withRouter(async ({ get }) => {
    const { body } = await get('/report');

    // A bare percentage invites "94% compliant" to be read as reassuring when the
    // denominator is 16 namespaces out of 400 that could actually be audited.
    assert.match(
      body,
      /Score \d+% \(\d+\/\d+ namespaces\)/,
      `expected a score reported with its denominator, got:\n${body}`
    );

    // The regression itself: the old template produced exactly this string.
    assert.ok(!body.includes('Score undefined'), 'the summary.score regression is back');
  });
});

/**
 * The header-presence assertion this replaces — `assert.match(body, /## Data Completeness/)`
 * — passed while the section underneath it read "All collectors reported successfully —
 * every figure above is a measured value" over a fleet whose security collector had just
 * been refused a resource by RBAC. A 403 arriving at the operator as the number 0 is the
 * exact failure safe-list.js exists to prevent, and the report is the last place it can be
 * quietly reintroduced: a heading proves nothing about what is written under it.
 *
 * `serviceaccounts` is the resource to deny because, of the three collectors /report runs
 * (health, compliance, security), only security reads it — and only through `safeList`. The
 * denial therefore degrades exactly one figure while leaving the cluster `ok: true`, which
 * is precisely the case the completeness section has to notice. Denying something compliance
 * reads would fail the whole cluster and fill the section for the wrong reason, so the test
 * would still pass with the reporting of degraded collectors entirely broken.
 *
 * The clean sweep is collected first as a control. Without it, "the section names the denied
 * resource" is satisfiable by a section that names every resource unconditionally, which
 * would be no more informative than the heading.
 */
test('the report names the resource a collector was refused, instead of implying a clean bill of health', async () => {
  const DENIED = '/api/v1/serviceaccounts';
  const listFn = async args => {
    if (args.path === DENIED) {
      throw new ClusterError(
        FORBIDDEN,
        'serviceaccounts is forbidden: User "system:serviceaccount:kyma-fleet:fleet-reader" ' +
          'cannot list resource "serviceaccounts" in API group "" at the cluster scope',
        { cluster: args.cluster.id, status: 403 }
      );
    }
    return fixtures.listFn(args);
  };

  const completenessOf = async overrides => {
    let section;
    await withRouter(overrides, async ({ get }) => {
      const { status, body } = await get('/report');
      assert.equal(status, 200);
      assert.match(
        body,
        /## Data Completeness/,
        'a report with no completeness section reads as complete even when collectors failed'
      );
      section = body.split('## Data Completeness')[1] || '';
      assert.ok(section.trim(), `the Data Completeness section is empty:\n${body}`);
    });
    return section;
  };

  const clean = await completenessOf({});
  assert.ok(
    !clean.includes('serviceaccounts'),
    `a fleet with nothing refused named a resource as unreadable anyway:\n${clean}`
  );

  const degraded = await completenessOf({ listFn });
  assert.match(
    degraded,
    /serviceaccounts/,
    'the completeness section did not name the resource that could not be read, so an ' +
      `operator cannot tell which figure to distrust:\n${degraded}`
  );
  // Both clusters were refused, and a section naming only one of them lets the other's
  // isolation score be read as measured.
  for (const displayName of ['Platform SBX', 'Kyma Dev']) {
    assert.ok(
      degraded.includes(displayName),
      `${displayName} was refused serviceaccounts but is absent from the completeness section:\n${degraded}`
    );
  }
  assert.ok(
    // The exact sentence has been reworded once already; what must never survive a refused
    // read is the affirmative claim, whatever words carry it.
    !/reported successfully|No gaps were reported/.test(degraded),
    'the report told the operator nothing was missing while the security collector was being ' +
      `refused serviceaccounts with a 403 — the counts it printed are floors, not totals:\n${degraded}`
  );
  assert.ok(
    !degraded.includes('cluster unreachable'),
    'one refused resource was reported as an unreachable cluster; the distinction between a ' +
      `cluster that is down and a figure that is short is the whole value of the section:\n${degraded}`
  );
});

/**
 * The scope sentence — what the report says it can VOUCH for, as opposed to what it found.
 *
 * This is deliberately a separate test from the one above, because the two failed differently.
 * The gap rows say "here is what was missed"; the scope sentence says "here is the set of
 * collectors capable of telling you that at all". A report can find nothing wrong for two
 * opposite reasons — nothing was wrong, or nothing was watching — and only this sentence
 * distinguishes them.
 *
 * Why it needs pinning: when the five safeList collectors gained `truncated`, this sentence
 * inverted from "Truncated reads are reported by no collector in this report" to "reported by:
 * security" — a change in a completeness GUARANTEE — and the entire suite stayed green,
 * because nothing asserted it. That is the same shape as the eslint-with-no-config and
 * no-test-mounts-the-router failures: a gate that passes by never looking.
 *
 * Asserted on structure, not on the full wording. The sentence has been reworded twice; what
 * must never break is that each key names its own reporters and its own non-reporters, and
 * that a collector which tracks nothing is never listed as a reporter.
 */
test('the report states, per key, which collectors can vouch for completeness and which cannot', async () => {
  let section;
  await withRouter({}, async ({ get }) => {
    const { status, body } = await get('/report');
    assert.equal(status, 200);
    section = body.split('## Data Completeness')[1] || '';
    assert.ok(section.trim(), `the Data Completeness section is empty:\n${body}`);
  });

  // /report fans out health, compliance and security. compliance gained its own
  // `unavailable`/`truncated` fields (Wave 0), and health gained them when the Nodes tab's
  // structural blindness was fixed — a ?limit=2000 pod read that hit the cap now says so instead
  // of publishing a confident count. So all three are reporters and the sentence has nothing left
  // to disclaim. Names come from the fan-out group names and render lowercase.
  for (const [heading, key] of [['Failed reads', 'unavailable'], ['Truncated reads', 'truncated']]) {
    const line = section.split('\n').find(l => l.startsWith(heading));
    assert.ok(line, `the report no longer states the scope of '${key}':\n${section}`);

    for (const collector of ['health', 'compliance', 'security']) {
      assert.match(
        line,
        new RegExp(`reported by:[^.]*\\b${collector}\\b`),
        `${collector} reads through safeList and populates '${key}', but the report does not ` +
          `credit it — an operator reading this cannot tell the section is watching anything:\n${line}`
      );
    }
    // The honest half, inverted: now that every fanned-out collector tracks completeness, a
    // lingering "Not by: health" would understate coverage as badly as omitting the clause once
    // overstated it. If a future collector joins /report without completeness keys, it must appear
    // here — so the clause is required to be absent only while nothing is uncovered.
    assert.ok(
      !/Not by:\s*health\b/.test(line),
      `health now populates both completeness keys, so the report must stop disclaiming it:\n${line}`
    );
    assert.ok(
      !/reported by no collector/.test(line),
      `the report disclaims '${key}' tracking entirely while all three collectors track it — ` +
        `understating coverage trains operators to ignore the section:\n${line}`
    );
  }
});

// ------------------------------------------------------- who a cluster is read as (OIDC)

/**
 * The seam these tests exist for: which credential the ROUTER hands to the fan-out.
 *
 * fanout.test.js proves `fanOut()` uses a `userToken` when it is given one, but it is the
 * test that supplies it. Nothing there — and nothing anywhere else — proves the router ever
 * does. That is the half that was broken before this commit, and deleting
 * `userToken: bearerFrom(req)` from `runFanOut()` puts it straight back: an OIDC cluster
 * silently drops to the fleet service account, every operator sees the service account's
 * view of it rather than their own, and the whole suite stays green.
 */

/** A bearer that can only have come from the request — the token store never produces it. */
const USER_BEARER = 'USER-SESSION-BEARER-b3d1f0';
/** What the token store holds for an OIDC cluster, so a fallback is silent rather than fatal. */
const FLEET_SA_TOKEN = 'FLEET-SA-TOKEN-NOT-THE-CALLER';
/**
 * A port nothing listens on. The two write routes take a token through `tokenFor()` and then
 * call the cluster through a transport with no injection seam, so an unroutable address is
 * what keeps that call an immediate ECONNREFUSED instead of a DNS wait.
 */
const NO_LISTENER = 'https://127.0.0.1:1';
const ALLOWLISTED_HOST = '127.0.0.1';
/** Named here rather than imported because router.js keeps it module-private. */
const PASSTHROUGH_ENV = 'FLEET_OIDC_PASSTHROUGH_HOSTS';

/**
 * Turn OIDC token passthrough on for one test, and put the environment back afterwards.
 *
 * It is off by default and deliberately so: `apiUrl` is a field of a cluster record that any
 * authenticated caller can create, so forwarding the signed-in operator's bearer to whatever
 * host is registered would turn one onboarded cluster into a collector of everybody else's
 * SSO token. The seam these tests cover — the router actually handing the request's bearer to
 * the fan-out — only exists on the far side of that allowlist, so each test names the host of
 * its own fixture cluster instead of leaving the behaviour unreachable.
 */
function allowPassthrough(t, hosts = ALLOWLISTED_HOST) {
  const before = process.env[PASSTHROUGH_ENV];
  process.env[PASSTHROUGH_ENV] = hosts;
  t.onTestFinished(() => {
    if (before === undefined) delete process.env[PASSTHROUGH_ENV];
    else process.env[PASSTHROUGH_ENV] = before;
  });
}

/**
 * Every test in this file runs as a fixed identity with `scopes: []` (the harness's own
 * comment says auth itself is out of scope here) — which is exactly what `requireAdmin`
 * refuses. A test exercising an admin-gated route through this harness has to switch
 * enforcement off for its own duration, the same way `allowPassthrough` toggles its env var.
 */
function disableAdminScope(t) {
  const before = process.env.FLEET_REQUIRE_ADMIN_SCOPE;
  process.env.FLEET_REQUIRE_ADMIN_SCOPE = 'false';
  t.onTestFinished(() => {
    if (before === undefined) delete process.env.FLEET_REQUIRE_ADMIN_SCOPE;
    else process.env.FLEET_REQUIRE_ADMIN_SCOPE = before;
  });
}

/** `authMode: 'oidc'` — the first half of the router's OIDC test, and what onboarding writes. */
const OIDC_BY_AUTHMODE = {
  id: 'oidc-authmode', displayName: 'OIDC by authMode', env: 'dev',
  apiUrl: NO_LISTENER, authMode: 'oidc', enabled: true
};
/**
 * `onboardedVia: 'oidc'` with `authMode` still 'token' — the second half of the same `||`.
 * Both halves are load-bearing: a record written before `authMode` existed carries only the
 * second, and reading it as a token cluster would send the service account at an SSO
 * endpoint that has never heard of it.
 */
const OIDC_BY_ONBOARDED_VIA = {
  id: 'oidc-onboardedvia', displayName: 'OIDC by onboardedVia', env: 'dev',
  apiUrl: NO_LISTENER, authMode: 'token', onboardedVia: 'oidc', enabled: true
};
/** The same cluster with no stored token at all — see the write-route test for why. */
const OIDC_NO_SA = {
  id: 'oidc-no-sa', displayName: 'OIDC without a stored token', env: 'dev',
  apiUrl: NO_LISTENER, authMode: 'oidc', enabled: true
};
/** An OIDC cluster whose host is NOT allowlisted: the caller's bearer must not reach it. */
const OIDC_ELSEWHERE = {
  id: 'oidc-elsewhere', displayName: 'OIDC on an unlisted host', env: 'dev',
  apiUrl: 'https://api.oidc-elsewhere.invalid', authMode: 'oidc', enabled: true
};

/**
 * Add a cluster through the registry's own onboarded-directory path — the same `_scanDir()`
 * plus `validate()` route a cluster added through the UI takes.
 *
 * Writing the file rather than pushing an object onto an internal array matters here:
 * `validate()` is what derives the final `authMode`/`onboardedVia` pair, and that pair is
 * the entire input to the router's OIDC decision. A test that skipped it could assert
 * against a shape the registry never actually produces.
 */
function onboardCluster(registry, cluster) {
  fs.writeFileSync(path.join(registry.dir, cluster.id), JSON.stringify(cluster));
  registry.invalidate();
  const stored = registry.get(cluster.id);
  assert.ok(stored, `the registry did not pick up onboarded cluster ${cluster.id}`);
  return stored;
}

/**
 * The fixture token store, plus a service-account token for ids its scenario table has never
 * heard of. Without this an onboarded OIDC cluster has no stored token, and dropping the
 * caller's bearer would fail the request loudly — which is not the bug being guarded against.
 * The dangerous version of that mistake is the silent one: a stored token stands in, the
 * response is 200, and it is somebody else's view of the cluster.
 */
function tokenStoreWith(extra) {
  const base = fixtures.createTokenStore();
  return {
    adopt: (...args) => base.adopt(...args),
    health: id => base.health(id),
    tokenFor: id => (Object.prototype.hasOwnProperty.call(extra, id) ? extra[id] : base.tokenFor(id))
  };
}

/** Record the credential every collector read is made with, then answer it normally. */
function recordingListFn(calls, inner = fixtures.listFn) {
  return async args => {
    calls.push({ cluster: args.cluster.id, token: args.token, path: args.path });
    return inner(args);
  };
}

/** Every distinct credential one cluster was read with during a request. */
const credentialsUsedFor = (calls, id) => [...new Set(calls.filter(c => c.cluster === id).map(c => c.token))];

/** One entry out of a fan-out response, asserted to have actually been collected. */
function entryFor(body, id) {
  const entry = (body.clusters || []).find(c => c.cluster && c.cluster.id === id);
  assert.ok(entry, `${id} is missing from the response entirely: ${JSON.stringify(body.clusters)}`);
  return entry;
}

/**
 * Serve the *same* router behind an identity taken from a request header.
 *
 * The harness pins `req.user` to one operator, which is exactly what a cross-user cache test
 * cannot use, and its middleware is registered ahead of the router so nothing added later can
 * displace it. Re-mounting the router object the harness already built — over its registry,
 * its cache and its transport seams — varies the caller without duplicating any of that
 * construction and without touching the harness.
 */
async function withIdentities(router, fn) {
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use(MOUNT_PATH, (req, _res, next) => {
    req.user = { id: req.headers['x-test-identity'], name: 'Router Test', scopes: [] };
    next();
  });
  app.use(MOUNT_PATH, router);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  try {
    const { port } = server.address();
    const asUser = async (identity, bearer, reqPath) => {
      const res = await fetch(`http://127.0.0.1:${port}${MOUNT_PATH}${reqPath}`, {
        headers: { 'x-test-identity': identity, authorization: `Bearer ${bearer}` }
      });
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      return { status: res.status, contentType, body: contentType.includes('json') ? JSON.parse(text) : text };
    };
    await fn(asUser);
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

test('a fan-out reads an OIDC cluster with the caller\'s own bearer and a token-mode cluster with the service account', async t => {
  allowPassthrough(t);
  const calls = [];
  const oidcIds = [OIDC_BY_AUTHMODE.id, OIDC_BY_ONBOARDED_VIA.id];
  const withSaToken = [...oidcIds, OIDC_ELSEWHERE.id];
  const tokens = tokenStoreWith(Object.fromEntries(withSaToken.map(id => [id, FLEET_SA_TOKEN])));

  await withRouter({ listFn: recordingListFn(calls), tokens }, async ({ get, registry }) => {
    onboardCluster(registry, OIDC_BY_AUTHMODE);
    onboardCluster(registry, OIDC_BY_ONBOARDED_VIA);
    onboardCluster(registry, OIDC_ELSEWHERE);

    const res = await get('/clusters', { headers: { authorization: `Bearer ${USER_BEARER}` } });
    assert.equal(res.status, 200);

    for (const id of oidcIds) {
      const entry = entryFor(res.body, id);
      assert.ok(entry.ok, `${id} was not collected at all: ${JSON.stringify(entry.error)}`);
      assert.deepStrictEqual(
        credentialsUsedFor(calls, id),
        [USER_BEARER],
        `${id} is an OIDC cluster on an allowlisted host and must be read as the signed-in ` +
          'operator. It was read with something else, which means the router never handed the ' +
          'request\'s bearer to the fan-out — the response is the service account\'s view of ' +
          'the cluster, not the caller\'s, and no status code says so'
      );
      assert.equal(
        entry.authFallback,
        undefined,
        `${id} reported an auth fallback even though the caller sent a bearer; the router ` +
          'dropped the token before fanout.js could see it'
      );
    }

    // Same sweep, same bearer, unlisted host: the allowlist is per cluster, not per request,
    // and forwarding to every OIDC cluster because one of them qualifies is the leak it
    // exists to stop. This is also what makes the assertions above mean something — without
    // an unlisted cluster in the fleet, "forward to everyone" passes them all.
    const elsewhere = entryFor(res.body, OIDC_ELSEWHERE.id);
    assert.deepStrictEqual(
      credentialsUsedFor(calls, OIDC_ELSEWHERE.id),
      [FLEET_SA_TOKEN],
      `${OIDC_ELSEWHERE.id} is not in ${PASSTHROUGH_ENV}; the caller's bearer must not be sent to it`
    );
    assert.equal(elsewhere.authFallback && elsewhere.authFallback.code, OIDC_FALLBACK_TO_SA);

    // The mirror image, and the reason the bearer cannot simply be forwarded everywhere: a
    // token-mode cluster is read with the same stored credential for everybody, and sending
    // an operator's IAS session token at it would authenticate as nobody it knows.
    const saToken = fixtures.createTokenStore().tokenFor('platformsbx');
    assert.deepStrictEqual(
      credentialsUsedFor(calls, 'platformsbx'),
      [saToken],
      'a token-mode cluster was read with something other than its stored service-account token'
    );
    assert.ok(
      !calls.some(c => c.cluster === 'platformsbx' && c.token === USER_BEARER),
      'the caller\'s bearer was sent to a token-mode cluster'
    );

    // A fleet split across two credentials is collected in two sweeps and stitched back
    // together; a cluster dropped or reordered by that merge is invisible to every caller.
    assert.deepStrictEqual(
      res.body.clusters.map(c => c.cluster.id),
      registry.active().map(c => c.id),
      'the mixed-credential fan-out did not return every active cluster in registry order'
    );
  });
});

test('with no Authorization header an OIDC cluster falls back to the service-account token and says so', async t => {
  // Passthrough is on for this cluster's host, so a missing header is the only thing that can
  // send the read to the service account.
  allowPassthrough(t);
  const calls = [];
  const id = OIDC_BY_AUTHMODE.id;
  const tokens = tokenStoreWith({ [id]: FLEET_SA_TOKEN });

  await withRouter({ listFn: recordingListFn(calls), tokens }, async ({ get, registry }) => {
    onboardCluster(registry, OIDC_BY_AUTHMODE);

    const res = await get('/clusters');
    assert.equal(res.status, 200);

    assert.deepStrictEqual(
      credentialsUsedFor(calls, id),
      [FLEET_SA_TOKEN],
      'with no bearer to forward, an OIDC cluster must still be read with the stored token ' +
        'rather than not at all'
    );

    const entry = entryFor(res.body, id);
    assert.ok(entry.ok, `${id} was not collected: ${JSON.stringify(entry.error)}`);
    assert.equal(
      entry.authFallback && entry.authFallback.code,
      OIDC_FALLBACK_TO_SA,
      'an OIDC cluster read as the service account must say so — the UI has no other way to ' +
        `explain why a permission differs from the operator's own: ${JSON.stringify(entry.authFallback)}`
    );
    assert.equal(entry.authFallback.cluster, id);

    // A token-mode cluster is always read as the service account, so flagging it as a
    // fallback would train operators to ignore the marker.
    assert.equal(entryFor(res.body, 'platformsbx').authFallback, undefined);
  });
});

/**
 * The cross-user leak, demonstrated rather than described.
 *
 * `scoped()` is the only thing standing between one signed-in operator's OIDC-scoped view of
 * a cluster and the next operator to load the page: both hit the same in-process `Cache`, and
 * an unscoped key hands the second caller the first caller's body. The node list here is
 * named after the credential it was read with, so "whose view is this" is readable straight
 * off the response.
 */
test('one operator\'s OIDC-scoped view is never served to the next operator out of the shared cache', async t => {
  allowPassthrough(t);
  const id = OIDC_BY_AUTHMODE.id;
  const nodeSeenBy = token => ({
    metadata: { name: `node-seen-by-${token}`, labels: {} },
    spec: {},
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      capacity: { cpu: '1', memory: '1Gi', pods: '10' },
      allocatable: { cpu: '1', memory: '1Gi', pods: '10' },
      nodeInfo: { kubeletVersion: 'v1.30.7' }
    }
  });
  const listFn = async args =>
    (args.cluster.id === id && args.path === '/api/v1/nodes' ? [nodeSeenBy(args.token)] : fixtures.listFn(args));

  await withRouter({ listFn, tokens: tokenStoreWith({ [id]: FLEET_SA_TOKEN }) }, async ({ router, registry }) => {
    onboardCluster(registry, OIDC_BY_AUTHMODE);

    await withIdentities(router, async asUser => {
      const nodesSeenBy = body => entryFor(body, id).data.nodes.items.map(n => n.name).join(', ');

      const alice = await asUser('alice@example.com', 'ALICE-BEARER', '/clusters');
      assert.equal(alice.status, 200);
      assert.equal(nodesSeenBy(alice.body), 'node-seen-by-ALICE-BEARER');

      // Inside the cache's 30s TTL, and deliberately so: an unscoped key is only dangerous
      // while the first caller's entry is still fresh.
      const bob = await asUser('bob@example.com', 'BOB-BEARER', '/clusters');
      assert.equal(bob.status, 200);
      assert.equal(
        nodesSeenBy(bob.body),
        'node-seen-by-BOB-BEARER',
        'the second operator was served the first operator\'s cached view of an OIDC cluster. ' +
          'That cluster is read with the signed-in user\'s own token, so this hands bob access ' +
          'alice had and bob may not — a cross-user data leak out of a shared cache, with no ' +
          'error and no log line'
      );
    });
  });
});

test('the cache key names the caller once an OIDC cluster is in the fleet, and stays shared while none is', async () => {
  const keys = [];
  const recordingCache = {
    wrap: (key, fn) => {
      keys.push(key);
      return fn();
    },
    invalidate: () => {}
  };

  await withRouter({ cache: recordingCache }, async ({ get, registry }) => {
    const { body: me } = await get('/me');

    await get('/clusters');
    assert.deepStrictEqual(
      keys,
      ['clusters'],
      'a fleet of token-mode clusters is read with the same stored credential for everybody, ' +
        'so its key must stay shared — scoping it per user multiplies every sweep by the ' +
        'number of signed-in operators for no security gain'
    );

    keys.length = 0;
    onboardCluster(registry, OIDC_BY_AUTHMODE);
    await get('/clusters');
    assert.deepStrictEqual(
      keys,
      [`clusters|as:${me.id}`],
      'once one OIDC cluster is registered every cached sweep contains that cluster read as ' +
        'the caller, so every key in the fleet has to carry the caller\'s identity'
    );
  });
});

/**
 * `/clusters/:id/logs` does not go through the fan-out — it resolves its credential through
 * `tokenFor(cluster, req)`, whose second argument is the whole fix. A `tokenFor` that ignores
 * `req` reads an OIDC cluster's pod logs as the service account, which is both the wrong
 * answer and the more sensitive one: logs are the only application data this dashboard shows.
 */
test('/clusters/:id/logs reaches an OIDC cluster as the caller, and as the service account only when no bearer arrives', async t => {
  allowPassthrough(t);
  const seen = [];
  const id = OIDC_BY_AUTHMODE.id;
  const textFn = async args => {
    seen.push({ cluster: args.cluster.id, token: args.token });
    return fixtures.textFn(args);
  };

  await withRouter({ textFn, tokens: tokenStoreWith({ [id]: FLEET_SA_TOKEN }) }, async ({ get, registry }) => {
    onboardCluster(registry, OIDC_BY_AUTHMODE);
    const query = '?namespace=btp-platform-foundation&pod=api-0&container=api';

    const authed = await get(`/clusters/${id}/logs${query}`, { headers: { authorization: `Bearer ${USER_BEARER}` } });
    assert.equal(authed.status, 200, JSON.stringify(authed.body));

    const anonymous = await get(`/clusters/${id}/logs${query}`);
    assert.equal(anonymous.status, 200, JSON.stringify(anonymous.body));

    const tokenMode = await get(`/clusters/platformsbx/logs${query}`, { headers: { authorization: `Bearer ${USER_BEARER}` } });
    assert.equal(tokenMode.status, 200, JSON.stringify(tokenMode.body));

    assert.deepStrictEqual(
      seen,
      [
        { cluster: id, token: USER_BEARER },
        { cluster: id, token: FLEET_SA_TOKEN },
        { cluster: 'platformsbx', token: fixtures.createTokenStore().tokenFor('platformsbx') }
      ],
      'tokenFor() must pick the caller\'s bearer for an OIDC cluster, the stored token when ' +
        'no bearer arrived, and the stored token for a token-mode cluster whatever the caller sent'
    );
  });
});

/**
 * The two write-shaped routes, `/restart` and `/rollout`, take their credential through the
 * same `tokenFor(cluster, req)` and then call the cluster through a transport the router has
 * no seam for — so the credential itself cannot be observed here the way the log tail's can.
 *
 * It does not need to be. Given an OIDC cluster with no stored token, `tokenFor` has exactly
 * one credential it could possibly use, and a `tokenFor` that does not look at `req` refuses
 * with UNSEEDED even when the caller sent one. The presence or absence of that refusal is the
 * arity fix, made visible without a network double.
 */
test('the single-cluster workload routes resolve an OIDC cluster\'s credential from the request, not only from the store', async t => {
  allowPassthrough(t);
  disableAdminScope(t); // this test is about tokenFor(), not requireAdmin
  await withRouter({ tokens: tokenStoreWith({ [OIDC_NO_SA.id]: null }) }, async ({ get, registry }) => {
    onboardCluster(registry, OIDC_NO_SA);
    const base = `/clusters/${OIDC_NO_SA.id}/workloads/btp-platform-foundation/api`;

    for (const [route, method] of [['rollout', 'GET']]) {
      const anonymous = await get(`${base}/${route}`, { method });
      assert.equal(
        anonymous.status,
        502,
        `${method} ${route} answered ${anonymous.status}, not the 502 a typed ClusterError ` +
          `produces (a 501 means FLEET_ALLOW_ROLLOUT is off in this environment): ${JSON.stringify(anonymous.body)}`
      );
      assert.equal(anonymous.body.code, 'UNSEEDED');
      assert.match(
        anonymous.body.message,
        /no user session token was received/,
        'an OIDC cluster with no session and no stored token must say which of the two is missing'
      );

      const authed = await get(`${base}/${route}`, { method, headers: { authorization: `Bearer ${USER_BEARER}` } });
      assert.notEqual(
        authed.body.code,
        'UNSEEDED',
        `${method} ${route} reported the cluster as unseeded while holding the caller's own ` +
          'bearer — tokenFor() looked only at the token store, so an OIDC cluster is ' +
          'unreachable for every operator no matter who is signed in'
      );
    }
  });
});

// ==================================================================== Wave 2

// ------------------------------------------------------------ cache-key scoping

/**
 * Grep-based, and exactly the kind of test this repo already uses for this invariant (see
 * `router.js`'s own comment on `scoped()`): every cache read — including the eight group
 * routes and /summary — must key through `scoped(req, ...)`, never a bare string literal or
 * template, or one operator's OIDC-scoped read leaks into the shared cache entry the next
 * operator reads.
 *
 * Two things are checked, not one. The keys must be scoped, **and** every call site must go
 * through the router's `cached(req, ...)` helper rather than `cache.wrap` directly. The
 * helper is what threads `onServed`, and `onServed` is the only thing that makes
 * `collectedAt` describe the read that produced the body rather than the moment the response
 * was written. A call site that reaches past it dates a possibly-stale body as fresh, which
 * is the failure the stale-while-revalidate cache would otherwise introduce.
 *
 * Canary: temporarily changing any one of the group routes' `cached(req, scoped(req, ...))`
 * to `cached(req, 'mesh', ...)` while writing this test made it fail with that literal key
 * named in the assertion message, confirming the regex actually inspects call sites and not
 * just their count. Changing one back to `cache.wrap(scoped(req, ...))` fails the second
 * assertion.
 */
test('every cache read in router.js goes through cached(req, scoped(req, ...))', () => {
  const src = fs.readFileSync(path.join(__dirname, '../router.js'), 'utf8');
  const calls = [...src.matchAll(/\bcached\(req,\s*([^,]+),/g)].map(m => m[1].trim());
  assert.ok(calls.length >= 25, `expected the router's full complement of cache call sites, found ${calls.length}`);

  // `cache.wrap` may appear exactly once — inside `cached` itself.
  const direct = [...src.matchAll(/\bcache\.wrap\(/g)].length;
  assert.equal(
    direct,
    1,
    `cache.wrap is called ${direct} times; only the \`cached\` helper may call it, or a route ` +
      'bypasses the onServed hook and stamps a stale body with a fresh collectedAt'
  );

  /*
    A key held in a local is accepted, but only when that local provably cannot be anything
    other than a scoped key.

    `/traffic-errors` needs the key twice — once to invalidate on a forced refresh, once to
    wrap — so inlining `scoped(req, ...)` at the call site would mean writing the key
    expression out twice and letting the two drift. Widening this check to "any identifier" is
    the wrong trade in the other direction: it would accept `cache.wrap(key, ...)` for a `key`
    built by hand, which is exactly the leak the test exists to prevent. So the name must be
    bound exactly once in the whole file, by a `const`, from `scoped(`.
  */
  const boundOnce = name => {
    const assignments = [...src.matchAll(new RegExp(`\\b${name}\\s*=(?!=)`, 'g'))].length;
    return assignments === 1 && new RegExp(`\\bconst\\s+${name}\\s*=\\s*scoped\\(`).test(src);
  };
  const isScoped = arg => arg.startsWith('scoped(') || (/^[A-Za-z_$][\w$]*$/.test(arg) && boundOnce(arg));

  const unscoped = calls.filter(arg => !isScoped(arg));
  assert.deepStrictEqual(
    unscoped,
    [],
    `cached called with a key that does not go through scoped(req, ...): ${unscoped.join(', ')} — ` +
      'an unscoped key leaks one user\'s OIDC-passthrough read to the next caller'
  );
});

// --------------------------------------------------------- new collectors wired for real

/**
 * Each of Part A's eight new fleet-wide routes must carry the real collector payload on
 * every cluster slot (`clusterSlot(r, { data: r.data })`), not a value recomputed from a
 * flattened list — there is nothing to flatten `data` from, so there is nothing for this
 * route to get wrong the way the old `/certificates` and `/workloads` counts did.
 */
test('the eight new group routes carry each cluster\'s real collector payload, not a recomputed count', async () => {
  await withRouter(async ({ get, registry }) => {
    for (const path of ['mesh', 'modules', 'btp-services', 'policy', 'capacity', 'reliability', 'observability', 'integrity']) {
      const { status, body } = await get(`/${path}`);
      assert.equal(status, 200, `GET /${path} -> ${status}: ${JSON.stringify(body)}`);
      assert.ok(Array.isArray(body.clusters), `GET /${path} has no clusters array`);
      assert.ok(body.clusters.length >= registry.active().length, `GET /${path} did not sweep every active cluster`);
      for (const slot of body.clusters) {
        assert.ok('unavailable' in slot && 'truncated' in slot, `GET /${path} cluster slot for ${slot.id} is missing the completeness lists`);
        if (slot.ok) {
          assert.ok(slot.data && typeof slot.data === 'object', `GET /${path} cluster slot for ${slot.id} is ok but carries no collector data`);
        }
      }

      const single = await get(`/clusters/${registry.active()[0].id}/${path}`);
      assert.equal(single.status, 200, `GET /clusters/:id/${path} -> ${single.status}: ${JSON.stringify(single.body)}`);
    }
  });
});

// -------------------------------------------------------------- /certificates null fix

/**
 * The anti-pattern named in this wave's brief: `certs.length` after flattening a cluster
 * whose read was refused reads a 403 back as a confident 0. `totalCertificates` must stay
 * `null` at the fleet level exactly when the collector itself says `null` for every
 * reachable cluster.
 *
 * Canary: reverting the fix (summing `certs.length` instead of each cluster's own
 * `summary.totalCertificates`) makes this assertion fail with `0`, not `null` — verified
 * by hand before writing this comment.
 */
test('/certificates reports totalCertificates: null when no cluster could answer, never a recomputed 0', async () => {
  for (const cluster of ['platformsbx', 'demo-dev']) {
    fixtures.setDiscoveryOverride(cluster, 'cert-manager.io', { list: 403 });
    fixtures.setDiscoveryOverride(cluster, 'cert.gardener.cloud', { list: 403 });
  }
  try {
    await withRouter(async ({ get }) => {
      const { status, body } = await get('/certificates');
      assert.equal(status, 200);
      assert.strictEqual(
        body.summary.totalCertificates,
        null,
        `expected null when every cluster's certificate read was refused, got ${JSON.stringify(body.summary.totalCertificates)}`
      );
    });
  } finally {
    for (const cluster of ['platformsbx', 'demo-dev']) {
      fixtures.setDiscoveryOverride(cluster, 'cert-manager.io', undefined);
      fixtures.setDiscoveryOverride(cluster, 'cert.gardener.cloud', undefined);
    }
  }
});

// --------------------------------------------------------------------- /drift, rewired

test('/drift\'s moduleParity is sourced from modules.js\'s Kyma CR read, not a workloads name-substring guess', async () => {
  await withRouter(async ({ get }) => {
    const { status, body } = await get('/drift');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.moduleParity));
    // The literal string this bug's old fixed list depended on must not appear as a
    // hardcoded module name anywhere in the router source — the real check is the source
    // grep below; this is the behavioural half.
    for (const row of body.moduleParity) {
      assert.ok(typeof row.module === 'string' && row.module.length > 0);
      assert.ok(row.clusterStatus && typeof row.clusterStatus === 'object');
    }
  });

  const src = fs.readFileSync(path.join(__dirname, '../router.js'), 'utf8');
  assert.ok(!src.includes('CORE_MODULES'), 'the hardcoded CORE_MODULES name-substring list must be gone from router.js');
  assert.ok(!/scoped\(req, ['"]drift:/.test(src), '/drift must reuse the clusters/workloads cache keys, not mint its own drift:* copies');
});

test('/drift compares clusters on allocatable, so the parity table cannot contradict a cluster detail page', async () => {
  await withRouter(async ({ get }) => {
    const drift = await get('/drift');
    assert.equal(drift.status, 200);
    const rows = drift.body.clusterParity.filter(r => r.ok);
    assert.ok(rows.length > 0, 'the fixture fleet must have at least one reachable cluster');

    for (const row of rows) {
      // The column headers read "Allocatable CPU"/"Allocatable Memory". Sending raw capacity
      // under them is how this page printed 16 cores / 64 GiB while the cluster's own page
      // showed 15.8 / 60 for the same nodes.
      assert.equal(typeof row.cpuAllocatable, 'number');
      assert.equal(typeof row.memoryAllocatable, 'number');
      assert.ok(!('cpuCapacity' in row), 'raw capacity must not ride along under an allocatable header');
      assert.ok(!('memoryCapacity' in row), 'raw capacity must not ride along under an allocatable header');

      // …and the number must be the same one the cluster's own page reports, to the byte.
      const detail = await get(`/clusters/${row.id}`);
      assert.equal(detail.status, 200);
      assert.equal(row.cpuAllocatable, detail.body.data.capacity.cpu.allocatable);
      assert.equal(row.memoryAllocatable, detail.body.data.capacity.memory.allocatable);
    }
  });
});

// ------------------------------------------------------------------------ /summary
test('/summary reports one {state, unavailable, truncated, absent} entry for every group, existing and new', async () => {
  await withRouter(async ({ get }) => {
    const { status, body } = await get('/summary');
    assert.equal(status, 200);
    const expected = [
      'health', 'compliance', 'workloads', 'networking', 'storage', 'security', 'autoscaling',
      'certificates', 'topology', 'mesh', 'modules', 'btpServices', 'policy', 'capacity',
      'reliability', 'observability', 'integrity'
    ];
    for (const key of expected) {
      assert.ok(key in body.groups, `GET /summary is missing group '${key}'`);
      const g = body.groups[key];
      assert.ok(['ok', 'degraded', 'error'].includes(g.state), `group '${key}' has an unrenderable state: ${g.state}`);
      assert.ok(Array.isArray(g.unavailable) && Array.isArray(g.truncated), `group '${key}' is missing its completeness lists`);
      assert.ok('absent' in g, `group '${key}' omits its own key entirely, which makes the client-side 'unqueried' distinction impossible`);
    }
  });
});

// ------------------------------------------------------- /clusters/:id/summary

/** The seventeen groups, in the order `SUMMARY_GROUPS` declares them. */
const SUMMARY_GROUP_KEYS = [
  'health', 'compliance', 'workloads', 'networking', 'storage', 'security', 'autoscaling',
  'certificates', 'topology', 'mesh', 'modules', 'btpServices', 'policy', 'capacity',
  'reliability', 'observability', 'integrity'
];

test('/clusters/:id/summary answers the same seventeen verdicts as /summary, for one cluster', async () => {
  await withRouter(async ({ get }) => {
    const { status, body } = await get('/clusters/platformsbx/summary');
    assert.equal(status, 200);
    assert.equal(body.cluster.id, 'platformsbx', 'the tile grid names the cluster it describes');

    for (const key of SUMMARY_GROUP_KEYS) {
      assert.ok(key in body.groups, `GET /clusters/:id/summary is missing group '${key}'`);
      const g = body.groups[key];
      assert.ok(['ok', 'degraded', 'error'].includes(g.state), `group '${key}' has an unrenderable state: ${g.state}`);
      assert.ok(Array.isArray(g.unavailable) && Array.isArray(g.truncated), `group '${key}' is missing its completeness lists`);
      assert.ok('absent' in g, `group '${key}' omits its own key, which makes the tile's 'not installed' state impossible`);
    }

    // The fleet's other cluster must not have been read to answer a question about this one.
    assert.ok(!JSON.stringify(body).includes('demo-dev'), 'a per-cluster summary leaked another cluster into its response');
  });
});

/**
 * The load-bearing claim in `SUMMARY_GROUPS`: each group's `clusterKey` is the key that
 * group's own per-cluster route already caches under, so opening a cluster's Overview warms
 * every tab behind it instead of opening a parallel set of cache entries.
 *
 * Nine of those keys are hand-written prefixes that are *not* `${cacheKey}:${id}` —
 * `cluster:`, `ns:`, `wl:…:*`, `net:…:*`, `stor:…:*`, `sec:`, `as:`, `cert:`, `topo:`. Getting
 * one wrong is invisible: the page still renders, correctly, having silently re-issued every
 * read the tile just made. So this test counts transport calls rather than inspecting keys —
 * a mismatch shows up as work, which is the thing that actually matters.
 */
test('/clusters/:id/summary shares a cache entry with every per-cluster tab route it summarises', async () => {
  let calls = 0;
  const countingListFn = (...args) => {
    calls += 1;
    return fixtures.listFn(...args);
  };

  await withRouter({ listFn: countingListFn }, async ({ get }) => {
    const primed = await get('/clusters/platformsbx/summary');
    assert.equal(primed.status, 200);
    assert.ok(calls > 0, 'the summary read nothing at all, so this test would pass vacuously');

    // Every route whose collector appears in SUMMARY_GROUPS, with the path the UI actually
    // requests (no namespace filter — that is a different, legitimately separate cache entry).
    const shared = [
      ['health', '/clusters/platformsbx'],
      ['compliance', '/clusters/platformsbx/namespaces'],
      ['workloads', '/clusters/platformsbx/workloads'],
      ['networking', '/clusters/platformsbx/networking'],
      ['storage', '/clusters/platformsbx/storage'],
      ['security', '/clusters/platformsbx/security'],
      ['autoscaling', '/clusters/platformsbx/autoscaling'],
      ['certificates', '/clusters/platformsbx/certificates'],
      ['topology', '/clusters/platformsbx/topology'],
      ['mesh', '/clusters/platformsbx/mesh'],
      ['modules', '/clusters/platformsbx/modules'],
      ['btpServices', '/clusters/platformsbx/btp-services'],
      ['policy', '/clusters/platformsbx/policy'],
      ['capacity', '/clusters/platformsbx/capacity'],
      ['reliability', '/clusters/platformsbx/reliability'],
      ['observability', '/clusters/platformsbx/observability'],
      ['integrity', '/clusters/platformsbx/integrity']
    ];

    const missed = [];
    for (const [group, route] of shared) {
      const before = calls;
      const { status } = await get(route);
      assert.equal(status, 200, `${route} did not answer 200`);
      if (calls > before) missed.push(`${group} (${route}) re-read ${calls - before} time(s)`);
    }

    assert.deepStrictEqual(
      missed,
      [],
      'these groups do not share a cache entry with their own tab route, so the Overview doubles ' +
        'their read cost and a tile can disagree with the tab it links to:\n  ' + missed.join('\n  ')
    );
  });
});

// -------------------------------------------------------------- OIDC bootstrap (Approach D)

const OIDC_BOOTSTRAP_CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIByDCCAW6gAwIBAgI=\n-----END CERTIFICATE-----\n';
const OIDC_BOOTSTRAP_CA_B64 = Buffer.from(OIDC_BOOTSTRAP_CA_PEM, 'utf8').toString('base64');

function oidcExecKubeconfig({ server, issuer, clientId = 'test-client-id', extraScopes = [] }) {
  return `
apiVersion: v1
kind: Config
current-context: ctx
clusters:
  - name: c1
    cluster:
      server: ${server}
      certificate-authority-data: ${OIDC_BOOTSTRAP_CA_B64}
contexts:
  - name: ctx
    context:
      cluster: c1
      user: u1
users:
  - name: u1
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl-oidc_login
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=${issuer}
          - --oidc-client-id=${clientId}${extraScopes.map(s => `\n          - --oidc-extra-scope=${s}`).join('')}
`;
}

/**
 * A minimal in-memory `{patch, remove}` writer, matching the interface `createRouter`'s own
 * jsdoc documents — enough to enable onboarding in a router test without a real Secret
 * write. Onboarding is otherwise untested at the router layer.
 */
function memoryWriter() {
  const store = new Map();
  return {
    store,
    patch: async (id, fields) => { store.set(id, { ...(store.get(id) || {}), ...fields }); return store.get(id); },
    remove: async (id) => { store.delete(id); return { removed: true }; }
  };
}

/**
 * A clusterWriter that ALSO materializes each patch as a file in the Registry's own watched
 * directory (mirroring dev-server.js's `fs.writeFileSync(path.join(clustersDir, id), ...)`
 * pattern) — a plain in-memory writer is invisible to `Registry._scanDir()`, so a cluster
 * onboarded through it never shows up via `registry.get()` even though the router's own
 * `registry.unremove()` + `registry.invalidate()` calls succeed. Needs the registry instance
 * itself, so it's built lazily off `registry.dir` inside the test rather than up front.
 */
function fileBackedClusterWriter() {
  const store = new Map();
  const writer = {
    store,
    dir: null, // set once the test's `registry` instance is available, before any request
    patch: async (id, fields) => {
      const record = { ...(store.get(id) || {}), ...fields };
      store.set(id, record);
      if (writer.dir) fs.writeFileSync(path.join(writer.dir, id), JSON.stringify(record));
      return record;
    },
    remove: async (id) => {
      store.delete(id);
      if (writer.dir) fs.rmSync(path.join(writer.dir, id), { force: true });
      return { removed: true };
    }
  };
  return writer;
}

/** Swap global fetch for the duration of one test, restoring it unconditionally after. */
function withFakeFetch(t, impl) {
  const before = global.fetch;
  global.fetch = impl;
  t.onTestFinished(() => { global.fetch = before; });
}

test('bootstrap-oidc: an attacker-controlled apiUrl/issuer is refused by the same allowlist ' +
  'the OIDC passthrough path already enforces, not a second, possibly-inconsistent check', async t => {
  disableAdminScope(t);
  const attackerHost = 'attacker.example.evil';
  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const body = oidcExecKubeconfig({
      server: `https://${attackerHost}`,
      issuer: `https://${attackerHost}/issuer`
    });
    const res = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'attacker-cluster', kubeconfig: body })
    });
    assert.equal(res.status, 403, `expected the unallowlisted host to be refused, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.code, /OIDC_HOST_NOT_ALLOWLISTED|OIDC_ISSUER_NOT_ALLOWLISTED/);
  });
});

test('bootstrap-oidc happy path: discovery, PKCE authorization URL, code exchange, and a ' +
  'real fleet-reader token minted via the existing TokenRequest chain — the id_token itself ' +
  'never appears in any response', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-bootstrap-test.invalid');
  const issuer = 'https://issuer.oidc-bootstrap-test.invalid';
  const server = 'https://api.oidc-bootstrap-test.invalid';
  const MINTED_ID_TOKEN = 'SENTINEL_ID_TOKEN_MUST_NEVER_APPEAR_IN_A_RESPONSE';

  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    if (u === `${issuer}/oauth2/token`) {
      return { ok: true, json: async () => ({ id_token: MINTED_ID_TOKEN }) };
    }
    // Anything else is the test harness's own client calling the router under test over a
    // real socket — pass it through to the real fetch rather than treating it as unexpected.
    return realFetch(url, init);
  });

  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    // The writer needs the Registry's own watched directory to make a brand-new cluster
    // visible to `registry.invalidate()` -> `_scanDir()`; that path only exists once the
    // harness has constructed the registry, so it's wired here rather than at construction.
    clusterWriter.dir = registry.dir;
    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'sso-cluster',
        kubeconfig: oidcExecKubeconfig({ server, issuer })
      })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    assert.ok(start.body.flowId);
    const authUrl = new URL(start.body.authorizationUrl);
    assert.equal(authUrl.origin + authUrl.pathname, `${issuer}/oauth2/authorize`);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.get('state'), start.body.flowId);

    const callback = await get(
      `/clusters/bootstrap-oidc/callback?code=AUTH_CODE_FROM_ISSUER&state=${encodeURIComponent(start.body.flowId)}`
    );
    assert.equal(callback.status, 201, JSON.stringify(callback.body));
    assert.equal(callback.body.onboardedVia, 'oidc-bootstrap');
    assert.ok(!JSON.stringify(callback.body).includes(MINTED_ID_TOKEN), 'the id_token must never reach the response body');

    const cluster = registry.get('sso-cluster');
    assert.ok(cluster, 'the cluster was not registered after a successful callback');
    assert.equal(cluster.authMode, 'token', 'authMode must be "token" going forward — there is no ongoing OIDC session to track');
    assert.equal(cluster.onboardedVia, 'oidc-bootstrap');
  });
});

test('bootstrap-oidc callback: a rejected redirect_uri (the known IAS registration blocker) ' +
  'surfaces as a named, actionable error, never a silent hang or a fabricated success', async t => {
  disableAdminScope(t);
  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const res = await get('/clusters/bootstrap-oidc/callback?error=unauthorized_client&error_description=redirect_uri+not+registered&state=doesnotexist');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'OIDC_ISSUER_ERROR');
    assert.match(res.body.message, /redirect_uri not registered|unauthorized_client/);
  });
});

/**
 * The callback is reached by a *browser navigation*, not by `fetch`, so its failure mode is not a
 * wrong status — it is an operator staring at a page of JSON with no way back into the console.
 *
 * Both halves are asserted here because the split is the whole design: a browser gets redirected
 * to the console with the outcome on the URL, and every existing caller keeps the JSON it always
 * got. Getting the discriminator wrong in the permissive direction would have redirected the
 * entire test suite, so the JSON half is a canary as much as a check.
 */
test('bootstrap-oidc callback: a browser is redirected back to the console, a fetch still gets JSON', async t => {
  disableAdminScope(t);
  const BROWSER = { headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } };

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ baseUrl }) => {
    const url = `${baseUrl}/clusters/bootstrap-oidc/callback?error=unauthorized_client&error_description=redirect_uri+not+registered&state=nope`;

    // `redirect: 'manual'` so the 302 itself is observable; following it would land on the
    // console's index.html and assert nothing about where it was sent.
    const asBrowser = await fetch(url, { ...BROWSER, redirect: 'manual' });
    assert.equal(asBrowser.status, 302, 'a browser navigation must be handed back to the console');
    const location = asBrowser.headers.get('location');
    // `/onboard/advanced`, not `/onboard`: the sign-in is its own page, and that page holds the
    // explanation for the failure being asserted here. A redirect to the token page would drop
    // the operator somewhere that cannot say why the provider refused.
    assert.ok(location.startsWith('/kyma-fleet-dashboard/#/onboard/advanced?'), `unexpected redirect target: ${location}`);

    // The params live in the hash's own query string — that is where a HashRouter's
    // useSearchParams reads them from. Parsed the same way the page will parse them.
    const params = new URLSearchParams(location.slice(location.indexOf('?') + 1));
    assert.equal(params.get('sso'), 'failed');
    assert.equal(params.get('code'), 'OIDC_ISSUER_ERROR');
    assert.match(params.get('message'), /redirect_uri not registered/);

    // CANARY: node's fetch sends `Accept: */*`, which matches `html` under the naive
    // `accepts('html')` form. If this assertion ever starts seeing a 302, the discriminator has
    // regressed and every JSON caller of this route is being redirected.
    const asFetch = await fetch(url, { redirect: 'manual' });
    assert.equal(asFetch.status, 400, 'a wildcard Accept must still get the JSON error, not a redirect');
    assert.match(asFetch.headers.get('content-type') || '', /json/);
    assert.equal((await asFetch.json()).code, 'OIDC_ISSUER_ERROR');
  });
});

test('bootstrap-oidc callback: the redirect carries an outcome and an id, never a credential', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-redirect-test.invalid');
  const issuer = 'https://issuer.oidc-redirect-test.invalid';
  const server = 'https://api.oidc-redirect-test.invalid';
  const SENTINEL = 'SENTINEL_ID_TOKEN_MUST_NEVER_APPEAR_IN_A_URL';

  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    if (u === `${issuer}/oauth2/token`) {
      return { ok: true, json: async () => ({ id_token: SENTINEL, access_token: SENTINEL, refresh_token: SENTINEL }) };
    }
    return realFetch(url, init);
  });

  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, baseUrl, registry }) => {
    clusterWriter.dir = registry.dir;
    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sso-redirect', kubeconfig: oidcExecKubeconfig({ server, issuer }) })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));

    const res = await fetch(
      `${baseUrl}/clusters/bootstrap-oidc/callback?code=AUTH_CODE&state=${encodeURIComponent(start.body.flowId)}`,
      { headers: { accept: 'text/html,*/*;q=0.8' }, redirect: 'manual' }
    );
    assert.equal(res.status, 302, 'a successful browser callback must land back on the console');

    const location = res.headers.get('location');
    const params = new URLSearchParams(location.slice(location.indexOf('?') + 1));
    assert.equal(params.get('sso'), 'connected');
    assert.equal(params.get('cluster'), 'sso-redirect', 'the console needs the id to link to the cluster');

    // The whole point of doing the exchange server-side. A token on the URL would be in history,
    // in the referrer, and in every proxy log between here and the operator.
    assert.ok(!location.includes(SENTINEL), 'no token may ever appear in the redirect URL');
    assert.ok(registry.get('sso-redirect'), 'the cluster must be registered before the redirect');
  });
});

test('the redirect URI /me advertises is byte-identical to the one the flow actually sends', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-uri-test.invalid');
  const issuer = 'https://issuer.oidc-uri-test.invalid';

  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    return realFetch(url, init);
  });

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const me = await get('/me');
    const advertised = me.body.ssoCallbackUrl;
    assert.ok(advertised, '/me must tell the console which redirect URI to have registered');

    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'uri-parity',
        kubeconfig: oidcExecKubeconfig({ server: 'https://api.oidc-uri-test.invalid', issuer })
      })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));

    // Identity providers match `redirect_uri` as an exact string — measured against the live IAS
    // tenant, where even a trailing slash is refused. So "close enough" is not a property worth
    // asserting: the string an operator copies off the screen and sends to their administrator
    // has to be the same bytes the issuer is handed, or the registration silently will not match.
    const sent = new URL(start.body.authorizationUrl).searchParams.get('redirect_uri');
    assert.equal(sent, advertised);
    assert.ok(start.body.note.includes(advertised), 'the note must quote the same URI, not paraphrase it');
  });
});

/**
 * The parity test above only proves the two sides agree with each other, and they agree just as
 * happily on a wrong value: behind the approuter, which strips `Host` before proxying, a
 * request-derived URI is the cluster-internal service address. The issuer can never redirect a
 * browser to `http://...svc.cluster.local:8080`, so the button cannot work deployed and the
 * console prints that address as the thing an administrator should register.
 *
 * `FLEET_SSO_CALLBACK_URL` is the answer, and it has to win over the request. The forwarded
 * headers deliberately do not: the APIRule in front of this deployment injects its own
 * `x-forwarded-host`, so honouring them trades one wrong exact-string for another.
 */
test('the SSO callback URL is configured, not taken from a proxied request', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-proxy-test.invalid');
  const issuer = 'https://issuer.oidc-proxy-test.invalid';
  const PUBLIC = 'https://console.example.invalid/api/fleet/clusters/bootstrap-oidc/callback';

  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    return realFetch(url, init);
  });

  // Exactly what the approuter leaves on the wire: no browser-facing Host, the real one only in
  // x-forwarded-host, and the scheme only in x-forwarded-proto.
  const proxied = {
    headers: {
      'x-forwarded-host': 'console.example.invalid',
      'x-forwarded-proto': 'https'
    }
  };

  const before = process.env.FLEET_SSO_CALLBACK_URL;
  t.onTestFinished(() => {
    if (before === undefined) delete process.env.FLEET_SSO_CALLBACK_URL;
    else process.env.FLEET_SSO_CALLBACK_URL = before;
  });

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    delete process.env.FLEET_SSO_CALLBACK_URL;
    const derived = await get('/me', proxied);
    assert.equal(
      derived.body.ssoCallbackUrlConfigured, false,
      'an unset env var must be reported as derived, so the console can warn instead of instructing'
    );
    assert.ok(
      !derived.body.ssoCallbackUrl.startsWith('https://console.example.invalid'),
      'this documents the trap: without the env var the URI is the backend address, not the browser-facing one'
    );

    process.env.FLEET_SSO_CALLBACK_URL = PUBLIC;
    const configured = await get('/me', proxied);
    assert.equal(configured.body.ssoCallbackUrl, PUBLIC);
    assert.equal(configured.body.ssoCallbackUrlConfigured, true);

    // And the flow must send the same bytes, not just advertise them.
    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...proxied.headers },
      body: JSON.stringify({
        name: 'proxy-uri',
        kubeconfig: oidcExecKubeconfig({ server: 'https://api.oidc-proxy-test.invalid', issuer })
      })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    assert.equal(new URL(start.body.authorizationUrl).searchParams.get('redirect_uri'), PUBLIC);

    // A trailing slash is a different URI to every provider that matches exactly, so the
    // normalisation has to happen once, here, rather than in each operator's copy-paste.
    process.env.FLEET_SSO_CALLBACK_URL = `${PUBLIC}/`;
    assert.equal((await get('/me', proxied)).body.ssoCallbackUrl, PUBLIC);
  });
});

/**
 * The deployed value an administrator actually has to hand is the console's origin —
 * `https://btp-kyma-bookshop-sbx.btp.sap.apple.com`. The path after it is this router's own
 * constant, so requiring it to be retyped is a way to get it subtly wrong, not a way to configure
 * anything: one missing segment and the provider refuses a URI that looks correct on screen.
 *
 * The other two shapes are failures that must not be silent. A value with no scheme cannot be a
 * redirect URI at all, and a plain-http one on a public host is refused by IAS and leaks the
 * authorization code where it is not — in both cases the console has to *say so*, because the
 * thing it prints is an instruction somebody will follow into a change window.
 */
test('FLEET_SSO_CALLBACK_URL accepts an origin, and reports the shapes that cannot work', async t => {
  disableAdminScope(t);
  const ORIGIN = 'https://console.example.invalid';
  const FULL = `${ORIGIN}/api/fleet/clusters/bootstrap-oidc/callback`;

  const before = process.env.FLEET_SSO_CALLBACK_URL;
  t.onTestFinished(() => {
    if (before === undefined) delete process.env.FLEET_SSO_CALLBACK_URL;
    else process.env.FLEET_SSO_CALLBACK_URL = before;
  });

  await withRouter(async ({ get }) => {
    const me = async () => (await get('/me')).body;

    // 1. An origin is completed with the router's own callback path.
    process.env.FLEET_SSO_CALLBACK_URL = ORIGIN;
    let body = await me();
    assert.equal(body.ssoCallbackUrl, FULL, 'an origin-only value must gain the callback path');
    assert.equal(body.ssoCallbackUrlConfigured, true);
    assert.equal(body.ssoCallbackUrlSecure, true);
    assert.equal(body.ssoCallbackUrlProblem, null);

    // An origin with a trailing slash is the same origin, not a different one.
    process.env.FLEET_SSO_CALLBACK_URL = `${ORIGIN}/`;
    assert.equal((await me()).ssoCallbackUrl, FULL);

    // 2. No scheme is not a URL. It is ignored, and reported as ignored — the alternative is
    //    guessing https on a value the operator may have meant as http, and printing the guess.
    process.env.FLEET_SSO_CALLBACK_URL = 'console.example.invalid';
    body = await me();
    assert.equal(body.ssoCallbackUrlConfigured, false);
    assert.equal(body.ssoCallbackUrlProblem, 'CONFIGURED_VALUE_INVALID');
    assert.ok(
      !body.ssoCallbackUrl.includes('console.example.invalid'),
      'an unusable configured value must not be echoed back as the URI to register'
    );

    // 3. Plain http on a public host is honoured — the operator configured it — but flagged.
    process.env.FLEET_SSO_CALLBACK_URL = 'http://console.example.invalid';
    body = await me();
    assert.equal(body.ssoCallbackUrl, 'http://console.example.invalid/api/fleet/clusters/bootstrap-oidc/callback');
    assert.equal(body.ssoCallbackUrlConfigured, true);
    assert.equal(body.ssoCallbackUrlSecure, false, 'http on a public host is the case IAS refuses');
    assert.equal(body.ssoCallbackUrlProblem, 'CONFIGURED_VALUE_INSECURE');

    // 4. ...but http on loopback is the documented OAuth exception, and is what fleet:dev uses.
    //    Flagging it would put a permanent red warning on every local development session.
    process.env.FLEET_SSO_CALLBACK_URL = 'http://localhost:8099';
    body = await me();
    assert.equal(body.ssoCallbackUrl, 'http://localhost:8099/api/fleet/clusters/bootstrap-oidc/callback');
    assert.equal(body.ssoCallbackUrlSecure, true);
    assert.equal(body.ssoCallbackUrlProblem, null);

    // 5. Unset is still reported as derived, with a reason code the console can name.
    delete process.env.FLEET_SSO_CALLBACK_URL;
    body = await me();
    assert.equal(body.ssoCallbackUrlConfigured, false);
    assert.equal(body.ssoCallbackUrlProblem, 'DERIVED_FROM_REQUEST');
  });
});

/**
 * The Overview renders a Remove control, and it decides whether to render it from `/clusters`.
 * `/tokens` has always carried `canRemove`, but the Overview does not call `/tokens` — so without
 * this the page either hides a control on a fleet that can remove, or offers one that is
 * guaranteed to 403. Both are worse than asking the route that the page actually calls.
 */
test('/clusters reports canRemove alongside canOnboard, and per-row removable', async t => {
  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    // Scope enforcement is on by default and the harness identity carries no scopes, so this is
    // the deployed default: writers wired, caller not an admin, nothing removable. Asserted
    // rather than switched off, because a `canRemove: true` here would be the actual bug.
    const gated = await get('/clusters');
    assert.equal(gated.status, 200);
    assert.equal(gated.body.canRemove, false, 'a caller without the admin scope may not de-register');
    assert.equal(gated.body.canOnboard, false, 'and canRemove must track canOnboard, not diverge from it');
  });

  disableAdminScope(t);

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const res = await get('/clusters');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.canRemove, 'boolean', '/clusters must answer the question the Overview asks');
    assert.equal(res.body.canRemove, true, 'both writers are wired and admin scope is not enforced here');
    for (const row of res.body.clusters) {
      assert.equal(typeof row.removable, 'boolean', `${row.cluster.id} must say whether its record is deletable`);
    }
  });

  // No writers: nothing can be de-registered, and the page must be told that rather than
  // discovering it from a 403 after the operator has typed a cluster id out by hand.
  await withRouter({ clusterWriter: null, tokenWriter: null }, async ({ get }) => {
    assert.equal((await get('/clusters')).body.canRemove, false);
  });
});

/**
 * Removing a cluster in one tab and refreshing its detail page in another is the ordinary way to
 * reach a route for a cluster that is no longer registered. The honest answer is that it is gone;
 * `INTERNAL` — the error middleware's fallback for an error carrying no code — says the dashboard
 * broke, and the console prints that code to the operator verbatim.
 */
test('a route for an unregistered cluster answers 404 NOT_FOUND, not INTERNAL', async () => {
  await withRouter(async ({ get }) => {
    const res = await get('/clusters/never-onboarded');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
    assert.match(res.body.message, /unknown cluster/);
  });
});

/**
 * `state` is unguessable, but it is not secret once it has been sent to somebody — and an
 * authorization URL is a link. Without binding the callback to the identity that started the
 * flow, anyone who can start one can mail the link to a colleague who holds real admin on the
 * target cluster and have that colleague's sign-in used, server-side and invisibly, to create
 * RBAC there and hand the resulting token to the fleet.
 */
test('bootstrap-oidc callback: a flow can only be finished by the identity that started it', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-owner-test.invalid');
  const issuer = 'https://issuer.oidc-owner-test.invalid';
  const server = 'https://api.oidc-owner-test.invalid';

  const realFetch = global.fetch;
  let exchanges = 0;
  withFakeFetch(t, async (url, init) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    if (u === `${issuer}/oauth2/token`) {
      exchanges += 1;
      return { ok: true, json: async () => ({ id_token: 'VICTIM_ID_TOKEN' }) };
    }
    return realFetch(url, init);
  });

  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;

    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'mallory@corp' },
      body: JSON.stringify({ name: 'owner-bound', kubeconfig: oidcExecKubeconfig({ server, issuer }) })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));

    const stolen = await get(
      `/clusters/bootstrap-oidc/callback?code=VICTIM_AUTH_CODE&state=${encodeURIComponent(start.body.flowId)}`,
      { headers: { 'x-test-user': 'alice@corp' } }
    );
    assert.equal(stolen.status, 403, JSON.stringify(stolen.body));
    assert.equal(stolen.body.code, 'OIDC_FLOW_NOT_YOURS');

    // The refusal has to come *before* the exchange. Redeeming the victim's code and then
    // discarding the result would still have spent it, and still have told the IdP it was used.
    assert.equal(exchanges, 0, 'a foreign callback must be refused before any token exchange');
    assert.equal(registry.get('owner-bound'), null, 'nothing may be registered from a foreign callback');
  });
});

test('bootstrap-oidc: `--oidc-extra-scope=openid` does not produce a duplicated scope', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-scope-test.invalid');
  const issuer = 'https://issuer.oidc-scope-test.invalid';

  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    return realFetch(url, init);
  });

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'scope-dedup',
        // Exactly what a Gardener/Kyma kubeconfig carries: `openid` appears as an extra scope
        // alongside the one the router adds unconditionally.
        kubeconfig: oidcExecKubeconfig({
          server: 'https://api.oidc-scope-test.invalid',
          issuer,
          extraScopes: ['email', 'openid']
        })
      })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));

    const scope = new URL(start.body.authorizationUrl).searchParams.get('scope').split(' ');
    assert.deepEqual(scope, [...new Set(scope)], `scope repeats a value: ${scope.join(' ')}`);
    assert.ok(scope.includes('openid'), 'openid is mandatory for an OIDC request');
    assert.ok(scope.includes('email'), 'the file\'s own extra scopes must survive deduplication');
  });
});

test('the deleted OIDC stub ("oidc-session" bearer, hardcoded kubernetesVersion) is gone from router.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../router.js'), 'utf8');
  assert.ok(!src.includes('oidc-session'), 'the fabricated "oidc-session" bearer/stub onboarding branch must be deleted, not left to coexist with the real flow');
  assert.ok(!src.includes("kubernetesVersion: 'v1.31.0'"), 'the hardcoded fake kubernetesVersion from the deleted stub must be gone');
});

// ------------------------------------------------- read-only guarantee

/**
 * Kyma Fleet is a strictly read-only observability and investigation platform: it must never
 * mutate Kubernetes or Kyma cluster state. That is a product guarantee, and a guarantee that
 * lives only in prose ships broken — so this is the check that enforces it.
 *
 * Grep-based on purpose, like the `cache.wrap` scoping test above. A behavioural test can only
 * cover the routes someone remembered to write a case for; this fails on a mutating route the
 * moment it is added, which is the failure mode that matters. Confirmed to fail on a bad input:
 * adding back `router.post('/clusters/:id/workloads/:namespace/:name/restart', …)` trips it.
 *
 * The allowlist is the fleet's own bookkeeping, none of which touches a cluster object:
 * onboarding and offboarding write the dashboard's cluster registry, and token renewal mints
 * the short-lived credential the console *reads* with. Everything else must be a GET.
 */
test('no route mutates cluster state', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');

  const ALLOWED = new Set([
    'post /clusters',                    // onboard — writes the fleet registry, not a cluster
    'post /clusters/bootstrap-oidc',     // onboard, PKCE variant
    // Parses an uploaded kubeconfig and answers what it contains. Writes nothing, stores
    // nothing, and contacts no cluster — a POST only because a kubeconfig does not belong
    // in a query string. Covered by test/fleet/onboard-kubeconfig-token.test.js, including
    // that it echoes back no credential.
    'post /clusters/kubeconfig/describe',
    'delete /clusters/:id',              // offboard — removes from the registry; cluster untouched
    'post /clusters/:id/remove',
    'post /clusters/:id/delete',
    'post /tokens/:id/renew'             // mints the SA token every read depends on
  ]);

  const offenders = [...src.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map(m => `${m[1]} ${m[2]}`)
    .filter(r => !ALLOWED.has(r));

  assert.deepEqual(
    offenders,
    [],
    'these routes mutate state and are not on the read-only allowlist: ' + offenders.join(', ')
  );
});

/**
 * The same guarantee one layer down. A route is only half the surface — a PATCH/PUT/DELETE
 * helper sitting unrouted in a collector is a write path one `require` away, which is exactly
 * how `actions.restart` survived after its button was removed.
 */
test('no collector or action issues a write to the Kubernetes API', () => {
  const dir = path.join(__dirname, '..');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); }
      else if (e.name.endsWith('.js')) files.push(full);
    }
  })(dir);

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/method:\s*'(POST|PUT|PATCH|DELETE)'/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      const rel = path.relative(dir, file);

      // Credential minting: a TokenRequest POST is how a short-lived read token is obtained at
      // all. Refusing it would not make the console more read-only, it would make it blind.
      if (rel === 'sa-token.js' || rel === 'mint.js' || rel === 'renewer.js') continue;

      // Onboarding writes the target cluster exactly once, to create the ServiceAccount and the
      // fleet-reader ClusterRole that every subsequent read goes through. It is the bootstrap of
      // read access, is admin-gated, and touches nothing an operator would call a workload. This
      // is the widest carve-out on the list and the one to re-examine first if it grows.
      if (rel === 'onboard.js') continue;

      // The hub's own Secret, holding the per-cluster tokens. Not target-cluster state.
      if (rel === 'secret-writer.js') continue;

      // OAuth/OIDC token exchanges POST to an identity provider, not to a Kubernetes API.
      if (rel === 'kubeconfig.js' || rel === 'router.js') continue;

      offenders.push(`${rel}:${line} ${m[1]}`);
    }
  }

  assert.deepEqual(offenders, [], 'Kubernetes writes found outside the allowlist: ' + offenders.join(', '));
});

// ------------------------------------------------- OIDC discovery, hardened
//
// The allowlist check on `POST /clusters/bootstrap-oidc` runs against the *issuer*, and the
// issuer is not what the flow talks to afterwards. Discovery returns an
// `authorization_endpoint` and a `token_endpoint`, the browser is sent to the first with the
// flow's state, and the second receives the authorization code. Both were taken from the
// document verbatim, and `fetch`'s default `redirect: 'follow'` meant discovery itself could
// be handed to another host entirely — with the allowlist already satisfied three frames up.
//
// Both tests below are attacks on that gap, not shape checks.

test('bootstrap-oidc: a discovery document that nominates an off-allowlist token endpoint is ' +
  'refused — an allowlisted issuer authorises its own hosts, not whatever it names', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-endpoint-test.invalid');
  const issuer = 'https://issuer.oidc-endpoint-test.invalid';
  const server = 'https://api.oidc-endpoint-test.invalid';

  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          // The exfiltration: the code, and with it the operator's identity assertion, would
          // have been POSTed here.
          token_endpoint: 'https://collector.attacker.invalid/oauth2/token'
        })
      };
    }
    return realFetch(url, init);
  });

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const res = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'endpoint-swap', kubeconfig: oidcExecKubeconfig({ server, issuer }) })
    });
    assert.equal(res.status, 400, `expected the nominated endpoint to be refused, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'OIDC_ENDPOINT_NOT_ALLOWED');
    assert.match(res.body.message, /token_endpoint/);
    assert.ok(!res.body.authorizationUrl, 'no authorization URL may be handed out for a refused document');
  });
});

test('bootstrap-oidc: an off-allowlist authorization endpoint is refused too, and http is ' +
  'refused whatever the host', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-endpoint-test.invalid');
  const issuer = 'https://issuer.oidc-endpoint-test.invalid';
  const server = 'https://api.oidc-endpoint-test.invalid';

  const cases = [
    {
      what: 'an off-allowlist authorization_endpoint',
      doc: {
        authorization_endpoint: 'https://phish.attacker.invalid/oauth2/authorize',
        token_endpoint: `${issuer}/oauth2/token`
      },
      expect: /authorization_endpoint/
    },
    {
      what: 'a plaintext authorization_endpoint on an allowlisted host',
      doc: {
        authorization_endpoint: 'http://issuer.oidc-endpoint-test.invalid/oauth2/authorize',
        token_endpoint: `${issuer}/oauth2/token`
      },
      expect: /is not https/
    }
  ];

  for (const c of cases) {
    const realFetch = global.fetch;
    const restore = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url) === `${issuer}/.well-known/openid-configuration`) {
        return { ok: true, json: async () => c.doc };
      }
      return realFetch(url, init);
    };
    try {
      await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
        const res = await get('/clusters/bootstrap-oidc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'endpoint-swap-2', kubeconfig: oidcExecKubeconfig({ server, issuer }) })
        });
        assert.equal(res.status, 400, `${c.what}: got ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, 'OIDC_ENDPOINT_NOT_ALLOWED', c.what);
        assert.match(res.body.message, c.expect, c.what);
      });
    } finally {
      global.fetch = restore;
    }
  }
});

test('bootstrap-oidc: discovery refuses to follow a redirect, so the host that was ' +
  'allowlisted is the host that answers', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-endpoint-test.invalid');
  const issuer = 'https://issuer.oidc-endpoint-test.invalid';
  const server = 'https://api.oidc-endpoint-test.invalid';

  let sawRedirectMode = null;
  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) {
      sawRedirectMode = init && init.redirect;
      // What undici does with `redirect: 'error'` when the server answers 302. Asserting on
      // the option alone would pass against a build that set it and ignored it.
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    }
    return realFetch(url, init);
  });

  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const res = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'redirected-issuer', kubeconfig: oidcExecKubeconfig({ server, issuer }) })
    });
    assert.equal(sawRedirectMode, 'error', 'discovery must not follow redirects');
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.code, 'OIDC_DISCOVERY_FAILED');
  });
});

// The same gap one step later. The token endpoint was checked against the allowlist at step 1,
// but the code exchange is a POST, and a 307 or 308 from that endpoint makes a following fetch
// re-send the same body (the authorization code and the PKCE verifier) to wherever the
// Location header points.
test('bootstrap-oidc callback: the code exchange refuses to follow a redirect, so the code ' +
  'and verifier reach only the allowlisted token endpoint', async t => {
  disableAdminScope(t);
  allowPassthrough(t, '.oidc-endpoint-test.invalid');
  const issuer = 'https://issuer.oidc-endpoint-test.invalid';
  const server = 'https://api.oidc-endpoint-test.invalid';
  const attackerToken = 'https://collector.attacker.invalid/oauth2/token';

  const attackerSaw = [];
  let exchangeRedirectMode = null;
  const realFetch = global.fetch;
  withFakeFetch(t, async (url, init) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`
        })
      };
    }
    if (u === `${issuer}/oauth2/token`) {
      exchangeRedirectMode = init && init.redirect;
      // What undici does with a 308: under `redirect: 'error'` it throws; under the default
      // `follow` it re-POSTs the same body to the Location. Modelled on the option rather than
      // asserted on it alone, so a build that sets it and ignores it still fails.
      if (exchangeRedirectMode === 'error') {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
      }
      attackerSaw.push(String(init && init.body));
      return { ok: true, json: async () => ({ id_token: 'FORGED_ID_TOKEN', redirectedTo: attackerToken }) };
    }
    return realFetch(url, init);
  });

  await withRouter({ callFn: fixtures.callFn, clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const start = await get('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'redirected-token', kubeconfig: oidcExecKubeconfig({ server, issuer }) })
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));

    const callback = await get(
      `/clusters/bootstrap-oidc/callback?code=AUTH_CODE_FROM_ISSUER&state=${encodeURIComponent(start.body.flowId)}`
    );
    assert.deepEqual(attackerSaw, [], 'the authorization code was re-sent to a redirect target');
    assert.equal(exchangeRedirectMode, 'error', 'the code exchange must not follow redirects');
    assert.equal(callback.status, 502, JSON.stringify(callback.body));
    assert.equal(callback.body.code, 'OIDC_CODE_EXCHANGE_FAILED');
  });
});

// ------------------------------------------------ namespace sets on /clusters/:id/workloads

/**
 * `?namespace=` names a SET, and the route has to survive the two things a browser does to a
 * set: serialise it in whatever order the selection was built in, and repeat the key rather
 * than join it. Both of those are wiring — Express's query parsing, the cache key, the value
 * the collector is handed — so none of it is reachable from a collector-level test.
 */
test('workloads: a repeated ?namespace= reads each namespace at the source and ORs the rows', async () => {
  const paths = [];
  const listFn = args => { paths.push(args.path); return fixtures.listFn(args); };

  await withRouter({ listFn }, async ({ get }) => {
    const res = await get('/clusters/platformsbx/workloads?namespace=btp-integration&namespace=btp-observability');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const namespaces = [...new Set(res.body.data.items.map(i => i.namespace))].sort();
    assert.deepEqual(namespaces, ['btp-integration', 'btp-observability']);
    // btp-platform-foundation exists in the fixture and was not selected, so it must be
    // absent from the rows AND never have been read.
    assert.ok(!paths.some(p => p.includes('/namespaces/btp-platform-foundation/')), paths.join('\n'));
    assert.deepEqual(
      paths.filter(p => !p.includes('metrics.k8s.io') && !p.includes('/namespaces/')),
      [],
      'a namespace set must not fall back to a cluster-wide list for the object types'
    );
    assert.deepEqual(res.body.data.summary.unavailable, []);
  });
});

test('workloads: the two orderings of one namespace set are one cache entry', async () => {
  const keys = [];
  // A cache that records what it was asked for and otherwise gets out of the way. The key is
  // the whole point: `b,a` and `a,b` reaching two entries would double every read and let the
  // two views disagree by up to a TTL.
  const cache = { wrap: (key, fn) => { keys.push(key); return fn(); } };

  await withRouter({ cache }, async ({ get }) => {
    const a = await get('/clusters/platformsbx/workloads?namespace=btp-observability&namespace=btp-integration');
    const b = await get('/clusters/platformsbx/workloads?namespace=btp-integration&namespace=btp-observability');
    const c = await get('/clusters/platformsbx/workloads?namespace=btp-integration,btp-observability');
    for (const res of [a, b, c]) assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.deepEqual([...new Set(keys)], keys.slice(0, 1),
      `three spellings of one selection produced ${new Set(keys).size} cache keys: ${keys.join(' | ')}`);
    assert.match(keys[0], /^wl:platformsbx:btp-integration,btp-observability$/);
  });
});

test('workloads: a namespace that is not a namespace name answers 400, not a cluster envelope', async () => {
  await withRouter(async ({ get }) => {
    for (const bad of ['Btp-Integration', '..', '../../../apis/rbac.authorization.k8s.io/v1/clusterroles']) {
      const res = await get(`/clusters/platformsbx/workloads?namespace=${encodeURIComponent(bad)}`);
      // Not 200-with-an-error-envelope, which is how a throw inside the fan-out surfaces and
      // which would read to an operator as an outage rather than as a rejected parameter.
      assert.equal(res.status, 400, `${bad}: got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'INVALID_NAMESPACE');
    }

    const overCap = Array.from({ length: 20 }, (_, i) => `namespace=ns-${i}`).join('&');
    const res = await get(`/clusters/platformsbx/workloads?${overCap}`);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /too many namespaces/);
  });
});
