/**
 * The HTTP surface. Thin on purpose: every route resolves parameters, calls a collector
 * through the fan-out, and shapes the response. No cluster logic lives here.
 *
 * Two invariants worth stating out loud:
 *
 *   1. **No route ever returns a token value.** /api/fleet/tokens returns expiry, status
 *      and error strings — facts about the token, never the token. The same applies to
 *      the uploaded kubeconfig: it is read from the request, used, and dropped.
 *   2. **Every read is fan-out shaped.** A cluster that is down produces an entry with
 *      `ok: false` and a typed error, never a failed response. The dashboard's job is to
 *      tell you which cluster is broken, which it cannot do by breaking.
 */
import express from 'express';
import health from './collectors/health.js';
import compliance from './collectors/compliance.js';
import workloads from './collectors/workloads.js';
import networking from './collectors/networking.js';
import storage from './collectors/storage.js';
import security from './collectors/security.js';
import autoscaling from './collectors/autoscaling.js';
import certificates from './collectors/certificates.js';
import topology from './collectors/topology.js';
import logs from './collectors/logs.js';
import traffic from './collectors/traffic.js';
import traces from './collectors/traces.js';
import proxyLogShareModule from './collectors/proxy-log-share.js';
const { createLogShare } = proxyLogShareModule;
import registryShareModule from './collectors/registry-share.js';
const { createRegistryShare } = registryShareModule;
import mesh from './collectors/mesh.js';
import capacity from './collectors/capacity.js';
import cost from './collectors/cost.js';
import reliability from './collectors/reliability.js';
import observability from './collectors/observability.js';
import helm from './collectors/helm.js';
import helmRelated from './collectors/helm-related.js';
import resourceYaml from './collectors/resource-yaml.js';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fanoutModule from './fanout.js';
const { fanOut, Cache, publicCluster } = fanoutModule;
import signalsModule from './signals.js';
const { signalsOf, healthOf, statsOf } = signalsModule;
import mintModule from './mint.js';
const { mint } = mintModule;
import errorsModule from './errors.js';
const { ClusterError, UNSEEDED } = errorsModule;
import kubeconfigModule from './kubeconfig.js';
const { parseKubeconfig, describeKubeconfig, extractExecOidcParams, toClusterId, KubeconfigError } = kubeconfigModule;
import saToken from './sa-token.js';
import onboard from './onboard.js';
import actions from './actions.js';
import k8sModule from './k8s.js';
const { forgetAgent, withLowPriority, normaliseNamespaces } = k8sModule;
/** The scope name lives in auth.js. Two copies of it would eventually drift, and a route
 *  checking a scope nobody can be granted fails in the direction nobody notices. */
import authModule from './auth.js';
import { getLogger } from '../logger.js';
const { SCOPE: ADMIN_SCOPE } = authModule;

const MOUNT_PATH = '/api/fleet';
/** A kubeconfig is a few kilobytes. Anything larger is not one. */
const MAX_KUBECONFIG_BYTES = 256 * 1024;
/**
 * Below this, a response is sent as plain JSON — see the compression middleware in
 * `createRouter`. gzip adds about twenty bytes of framing plus a syscall, and every body under
 * this size in this API (`/me`, the typed 404, every error) is one somebody reads with `curl`.
 */
const MIN_GZIP_BYTES = 1024;

/**
 * Hosts the signed-in operator's own bearer token may be forwarded to, as a comma-separated
 * list. Unset or empty means OFF, and OFF is the default.
 *
 * Why an allowlist at all: an OIDC cluster is read with the caller's SSO token, and
 * `apiUrl` is a field of a cluster record that any authenticated caller can create. Without
 * this gate, registering one cluster pointed at a host you control makes every other
 * operator's dashboard post their SSO bearer to you on their next page load. With it off,
 * such a cluster is read with the fleet service-account token instead and fanout.js reports
 * the substitution through `authFallback`, so the UI can still explain the difference.
 *
 * Little is lost by defaulting to off: the app's SSO token is issued for this application,
 * not for a cluster apiserver — wrong issuer, wrong audience — so it is not a credential the
 * cluster would accept anyway, and forwarding it broadly is disclosure without benefit. The
 * allowlist exists for a deployment where an operator has deliberately arranged for it to
 * work, and naming those hosts is a chart change, never a request body.
 *
 * Entries are compared against the parsed URL host, never as substrings:
 *
 *   example.com    matches exactly that host
 *   .example.com   matches any subdomain of it, and not the apex — list that separately
 *
 * Nothing else is a pattern; no regex is ever built from this value. In particular
 * `evil-kubernetes.default.svc.attacker.com` matches neither `kubernetes.default.svc` nor
 * `.kubernetes.default.svc`.
 */
const OIDC_PASSTHROUGH_HOSTS_ENV = 'FLEET_OIDC_PASSTHROUGH_HOSTS';

/** Lowercase, unbracketed, no trailing root dot — the single form every comparison uses. */
function normaliseHost(value) {
  const host = String(value == null ? '' : value).trim().toLowerCase().replace(/\.+$/, '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** The host of an apiUrl, or null when it is not a parseable absolute URL. */
function hostOf(apiUrl) {
  try {
    return normaliseHost(new URL(String(apiUrl)).hostname) || null;
  } catch {
    return null;
  }
}

/** Parsed once per distinct value of the variable, so an empty fleet does not re-split it
 *  on every request and the startup line is printed once rather than per call. */
let passthroughCache = { raw: null, hosts: [] };

function passthroughHosts() {
  const raw = process.env[OIDC_PASSTHROUGH_HOSTS_ENV] || '';
  if (passthroughCache.raw === raw) return passthroughCache.hosts;

  const hosts = [];
  for (const part of raw.split(',')) {
    const entry = normaliseHost(part);
    if (!entry) continue;
    // A glob would mean a pattern language, and `*.example.com` is also a hostname the URL
    // parser accepts — so an entry like that would silently match a cluster registered at
    // that literal name and nothing else. Refuse it and say what to write instead.
    if (entry.includes('*') || entry.includes('/') || entry.includes(':')) {
      getLogger().warn(`[fleet] ignoring ${OIDC_PASSTHROUGH_HOSTS_ENV} entry "${part.trim()}": not a bare host. Use "example.com" or ".example.com".`);
      continue;
    }
    hosts.push(entry);
  }

  passthroughCache = { raw, hosts };
  getLogger().info(hosts.length
    ? `[fleet] OIDC token passthrough enabled for: ${hosts.join(', ')}`
    : `[fleet] OIDC token passthrough is OFF (${OIDC_PASSTHROUGH_HOSTS_ENV} is empty); OIDC clusters read as the fleet service account`);
  return hosts;
}

/**
 * The one allowlist check, factored out so the OIDC bootstrap route (Part D) can apply it
 * to an issuer URL as well as an apiUrl without writing a second, possibly-inconsistent
 * comparison. Fails closed on anything unparseable or empty.
 */
function hostAllowlisted(host) {
  return Boolean(host) && passthroughHosts().some(entry => (entry.startsWith('.') ? host.endsWith(entry) : host === entry));
}

/** May the caller's own token be sent to this cluster? Fail closed on anything unparseable. */
function passthroughAllowed(cluster) {
  return hostAllowlisted(hostOf(cluster && cluster.apiUrl));
}

/**
 * A literal IP in a link-local range — which on every cloud is also the instance metadata
 * endpoint at 169.254.169.254. Registering a cluster there aims the fleet's own credentialed
 * client at the node's metadata service, so it is refused at onboarding.
 *
 * Decoding is left to the URL constructor, which folds 2852039166, 0251.0376.0251.0376 and
 * ::ffff:169.254.169.254 down to their canonical forms before this ever sees them.
 *
 * Loopback and RFC1918 are deliberately not refused: a cluster on a private network is a
 * legitimate target, and local development talks to 127.0.0.1.
 */
function isLinkLocalIp(host) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(host);
  if (v4) return Number(v4[1]) === 169 && Number(v4[2]) === 254;
  if (!host.includes(':')) return false;
  // IPv4-mapped: the parser emits ::ffff:a9fe:xxxx, but accept the dotted tail too.
  if (/^::ffff:(a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3})$/.test(host)) return true;
  return /^fe[89ab][0-9a-f]:/.test(host);            // fe80::/10
}

/**
 * Everything an apiUrl must satisfy before it is written into the registry. Returns null
 * when it is acceptable, or the body to answer 400 with.
 */
function apiUrlRejection(apiUrl) {
  if (typeof apiUrl !== 'string' || !/^https:\/\//.test(apiUrl)) {
    return { code: 'BAD_API_URL', message: 'apiUrl is required and must be an https URL' };
  }
  const host = hostOf(apiUrl);
  if (!host) return { code: 'BAD_API_URL', message: 'apiUrl is not a parseable URL' };
  if (isLinkLocalIp(host)) {
    return {
      code: 'BLOCKED_API_URL',
      message: `apiUrl host ${host} is in a link-local range; that address is the node's instance ` +
        'metadata endpoint, not a Kubernetes API server'
    };
  }
  return null;
}

/**
 * Writes are gated on the admin scope, and that is the default. Two ways to be off, both
 * deliberate and both logged: FLEET_AUTH=none, which is local development only and which
 * server/index.js refuses to start with under NODE_ENV=production; and an explicit
 * FLEET_REQUIRE_ADMIN_SCOPE=false for a deployment whose admin group is not assigned yet.
 *
 * Read per call rather than captured, so the answer never disagrees with the environment.
 */
function adminScopeEnforced() {
  return process.env.FLEET_AUTH !== 'none' && process.env.FLEET_REQUIRE_ADMIN_SCOPE !== 'false';
}

/**
 * Every line break becomes a space; every other control character is dropped.
 *
 * Written as a code-point walk rather than a character class so that this file contains no
 * invisible characters of its own — a literal U+2028 in source is itself a line terminator
 * to some tooling, which is the same class of bug this function exists to prevent.
 *
 * The breaks are LF, CR, NEL (U+0085) and the Unicode line/paragraph separators
 * (U+2028/U+2029); several Markdown renderers break a line on all five.
 */
const LINE_BREAK_CODE_POINTS = new Set([0x0a, 0x0d, 0x85, 0x2028, 0x2029]);

function collapseControlChars(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (LINE_BREAK_CODE_POINTS.has(cp)) { out += ' '; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * One value, one line, no markup.
 *
 * `displayName` and `env` arrive in the onboarding request body and land in a document an
 * operator reads as a record of fact. A name carrying a newline forges report entries for
 * clusters that do not exist; one carrying `<img src=x onerror=...>` runs wherever the .md
 * is rendered.
 *
 * Line breaks collapse to a space rather than vanishing, so two words never silently join.
 * Truncation happens before escaping, so a cut can never leave a dangling backslash that
 * escapes the markup around it. What remains is backslash-escaped for every character that
 * could open Markdown structure or raw HTML; CommonMark renders those back as the literal
 * character.
 */
function mdCell(value) {
  const flat = collapseControlChars(String(value == null ? '' : value)).trim().slice(0, 200);
  return flat.replace(/[\\`*_[\]()#|~<>&]/g, ch => `\\${ch}`);
}

// ------------------------------------------------------- completeness aggregation

/**
 * The two completeness lists a collector publishes, and the difference between them.
 *
 *   unavailable  the read did not happen — 401, 403, timeout. The number is not a number;
 *                the UI renders an em-dash, never a digit.
 *   truncated    the read happened and stopped at `k8s.js`'s paging ceiling. The items are
 *                real and the number is a FLOOR — "at least 20000 pods", never a dash.
 *
 * They are aggregated identically and kept strictly apart. Folding a truncated read into
 * `unavailable` would throw away a true lower bound and replace it with "we could not ask",
 * which tells an operator less than the truth actually in hand.
 */
const COMPLETENESS_KEYS = ['unavailable', 'truncated'];

/**
 * Read both lists off one fan-out entry.
 *
 * Collectors publish them at `data.summary.*`; the top-level `data.*` path is read too, so a
 * collector that grows the field one level up is not silently ignored — reading only the
 * wrong one of those two is exactly how `/report` came to print "all clear" over a 403.
 * Absent means `[]`: a collector that tracks neither (health, compliance, workloads today)
 * yields two empty arrays rather than two missing keys, so every slot has the same shape.
 */
function completenessOf(result) {
  const data = (result && result.data) || null;
  const summary = (data && data.summary) || null;
  const out = {};
  for (const key of COMPLETENESS_KEYS) {
    const list = (summary && Array.isArray(summary[key]) && summary[key])
      || (data && Array.isArray(data[key]) && data[key])
      || [];
    out[key] = list.filter(label => typeof label === 'string' && label.length > 0);
  }
  return out;
}

/** The deduplicated union across a fan-out, for the fleet-level `summary`. */
function completenessUnion(results) {
  const sets = Object.fromEntries(COMPLETENESS_KEYS.map(k => [k, new Set()]));
  for (const r of results || []) {
    const one = completenessOf(r);
    for (const key of COMPLETENESS_KEYS) for (const label of one[key]) sets[key].add(label);
  }
  return Object.fromEntries(COMPLETENESS_KEYS.map(k => [k, [...sets[k]]]));
}

/**
 * One cluster's slot in a fleet-level response, in the single shape every such route uses.
 *
 * `{ id, ok, error }` was the old shape, and it dropped `r.data` — so the labels the
 * collectors had gone to the trouble of computing never reached the browser, and Storage,
 * Autoscaling, Networking and Topology went on rendering a confident `0` for a read that
 * was refused. The two lists ride on the slot itself, which is where the UI's
 * `unavailableScope()` looks first (`entriesOf(c)`), rather than nested under a `data` the
 * UI does not read.
 *
 * @param {object} r a fan-out result
 * @param {object} [extra] route-specific fields merged in after the standard ones
 */
function clusterSlot(r, extra) {
  return {
    id: r.cluster.id,
    ok: r.ok,
    error: r.error || null,
    ...completenessOf(r),
    ...(extra || {})
  };
}

// ------------------------------------------------------- OIDC bootstrap (Approach D)

/**
 * How long a pending Authorization Code + PKCE flow is honoured. A few minutes: long
 * enough for the operator to authenticate at the issuer, short enough that an abandoned
 * flow does not sit in memory (or get replayed) indefinitely.
 */
const OIDC_FLOW_TTL_MS = 5 * 60 * 1000;

/**
 * Pending bootstrap-oidc flows, keyed by an opaque flow id that doubles as the OAuth
 * `state` parameter. Never a cookie, never anything the browser can read: the verifier is
 * the one secret a PKCE flow depends on, and the whole point of PKCE is that only this
 * process ever holds it.
 */
const oidcFlows = new Map();

/**
 * Where the console is served, so the SSO callback can hand the browser back to it.
 *
 * The server mounts the compiled UI at this path, and vite's dev server uses the same `base`
 * (`VITE_BASE_PATH`, `/` by default), so one relative path is correct in both. Overridable for a deployment that
 * mounts it elsewhere; a trailing slash is trimmed so the join below cannot double it.
 */
const UI_BASE_PATH = (process.env.FLEET_UI_BASE_PATH || '').replace(/\/+$/, '');

/**
 * Finish the SSO callback in whatever way suits whoever asked.
 *
 * The callback is the one route in this router reached by a *browser navigation* rather than by
 * `fetch` — the issuer redirects the operator's window to it. Answering that with raw JSON dumps
 * the operator on a white page of braces with no way back, and on the error paths it is worse:
 * the thing they most need to read is rendered as an API payload.
 *
 * So the outcome is put on the console's own URL and the browser is sent there. Everything else —
 * tests, scripts, anyone calling it with `fetch` — still gets exactly the JSON it got before.
 *
 * `accepts(['json', 'html'])` rather than `accepts('html')` is the discriminator, deliberately:
 * a bare wildcard Accept header (node's fetch default, and every test in this repo) matches
 * `html` under the simpler form, which would have redirected the entire suite. Given an explicit
 * list, express returns the *first* entry on a wildcard tie, and the genuinely preferred type when
 * the client ranked them — precisely the split wanted here, since a browser sends
 * `text/html` ahead of the wildcard with a higher q value.
 *
 * Note the params ride in the hash's own query string (`#/onboard/advanced?sso=…`). The console is
 * a HashRouter, so that is where its `useSearchParams` reads from; putting them before the `#`
 * would make them invisible to the page. No credential is ever placed in either position — only
 * an outcome word, a cluster id, and an error code the operator can quote.
 *
 * The route is the SSO page, not the default Add Cluster page: that is where the operator started
 * the flow, where the failure explanations live, and where the form they filled in still is. A
 * redirect to `/onboard` would land them on a page with no sign-in control and no memory of what
 * they typed — the exact loss the second tab exists to avoid.
 */
function finishOidcCallback(req, res, status, payload, params) {
  if (req.accepts(['json', 'html']) !== 'html') return res.status(status).json(payload);
  const query = new URLSearchParams(params).toString();
  return res.redirect(302, `${UI_BASE_PATH}/#/onboard/advanced?${query}`);
}

/**
 * The address the identity provider must call back to, derived from the request that asked.
 *
 * One expression, used both to build the authorization URL and to tell the console what to show
 * an administrator — because the *only* thing that makes this URI useful is that it is character
 * for character the one the issuer will be sent. The issuer matches it as an exact string: a trailing
 * slash is enough to be refused (measured against the live tenant), so a hand-typed copy in the
 * UI would eventually differ from the real one and send an operator to their admin with a URI
 * that cannot work.
 *
 * Configured, not derived — with a derivation only as a development convenience.
 *
 * Deriving it from the request looked right and is wrong in the one topology that matters. The
 * reverse proxy in front of the pod commonly rewrites `Host` before proxying, so
 * `req.get('host')` in the deployed pod is the internal service address and `req.protocol` is
 * `http`; the operator would be told to register
 * `http://...svc.cluster.local:8080/...` and the issuer would refuse the flow forever. The
 * forwarded headers are no better here: the ingress in front of this deployment may inject its own
 * `x-forwarded-host`, so trusting them swaps one wrong exact-string for another.
 *
 * Hence `FLEET_SSO_CALLBACK_URL`, which must be set to the exact browser-facing callback URL
 * anywhere this runs behind a proxy. When it is unset the request-derived value is used, which
 * is correct for `npm run fleet:dev` on :8099 and for a port-forward, and `/me` reports that it
 * was derived so the console can say so rather than presenting a guess as fact.
 */
const SSO_CALLBACK_URL_ENV = 'FLEET_SSO_CALLBACK_URL';

/** The one path the callback route is mounted at. Appended when only an origin is configured. */
const OIDC_CALLBACK_PATH = `${MOUNT_PATH}/clusters/bootstrap-oidc/callback`;

/**
 * An `http://` callback is a token-interception hazard and most providers refuse to register one
 * — but `http://localhost` is the documented exception every OAuth provider carves out, and it is
 * what `npm run fleet:dev` actually uses. So the check is on the *host*, not the scheme alone.
 */
function isLoopback(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * The callback URL, plus an honest account of where it came from.
 *
 * `FLEET_SSO_CALLBACK_URL` may be given either as the full callback URL or as just the origin the
 * console is served from (`https://fleet.example.com`) — the path is this router's own constant,
 * so making an operator retype it is a way to get it subtly wrong rather than a way to configure
 * anything. A value that is neither is not silently repaired or silently dropped: the derived URI
 * is used and the reason travels to `/me`, because the failure this guards against is precisely a
 * console that prints an unusable URI as if it were fact.
 *
 * @returns {{url: string, configured: boolean, secure: boolean, problem: string|null}}
 */
function ssoCallback(req) {
  const derived = `${req.protocol}://${req.get('host')}${OIDC_CALLBACK_PATH}`;
  const secureOf = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' || isLoopback(u.hostname);
    } catch {
      return false;
    }
  };

  const raw = (process.env[SSO_CALLBACK_URL_ENV] || '').trim();
  if (!raw) {
    return { url: derived, configured: false, secure: secureOf(derived), problem: 'DERIVED_FROM_REQUEST' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: derived, configured: false, secure: secureOf(derived), problem: 'CONFIGURED_VALUE_INVALID' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url: derived, configured: false, secure: secureOf(derived), problem: 'CONFIGURED_VALUE_INVALID' };
  }

  // An origin with no path of its own means "the console lives here"; complete it. Anything else
  // is taken literally, minus a trailing slash — which is a different URI to an exact-match
  // provider, and normalising it once here beats normalising it in every operator's copy-paste.
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path === '' ? OIDC_CALLBACK_PATH : path;
  parsed.search = '';
  parsed.hash = '';
  const url = parsed.toString();

  const secure = secureOf(url);
  return { url, configured: true, secure, problem: secure ? null : 'CONFIGURED_VALUE_INSECURE' };
}

function oidcRedirectUri(req) {
  return ssoCallback(req).url;
}

function pruneOidcFlows(now = Date.now()) {
  for (const [id, flow] of oidcFlows) if (flow.expiresAt <= now) oidcFlows.delete(id);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * GET <issuer>/.well-known/openid-configuration, at request time, against whatever issuer
 * a customer's kubeconfig names — never a hardcoded path for a single measured issuer.
 * Every failure is named: a caller sees why discovery failed, never a bare timeout.
 *
 * Two things here are security, not plumbing, and both exist because the caller's allowlist
 * check happens on the *issuer* and the issuer is not what gets contacted afterwards:
 *
 *  - `redirect: 'error'`. The default is `follow`, so an allowlisted issuer that answers 302
 *    could hand discovery to any host on the internet and the document that came back would
 *    carry that host's authorization and token endpoints — with the allowlist check already
 *    passed, three frames up. Refusing the redirect means the host we checked is the host we
 *    talked to. A legitimate issuer that really does redirect is a configuration to fix at the
 *    issuer, not a hole to leave open.
 *  - Both endpoints from the document are re-run through `hostAllowlisted` and required to be
 *    https. They are URLs *the document chooses*, and the browser is about to be sent to one of
 *    them with the flow's state while the other receives the authorization code. An issuer
 *    entry in the allowlist authorises that issuer's own hosts, not whatever it nominates.
 */
function endpointRejection(label, value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return `${label} "${value}" is not a URL`;
  }
  if (parsed.protocol !== 'https:') return `${label} ${parsed.origin} is not https`;
  if (!hostAllowlisted(parsed.hostname.toLowerCase())) {
    return `${label} host ${parsed.hostname} is not in ${OIDC_PASSTHROUGH_HOSTS_ENV}`;
  }
  return null;
}

async function discoverOidc(issuer) {
  const url = `${String(issuer).replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let doc;
  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!resp.ok) {
      const err = new Error(`issuer discovery at ${url} answered ${resp.status}`);
      err.code = 'OIDC_DISCOVERY_FAILED';
      throw err;
    }
    doc = await resp.json();
  } catch (err) {
    if (err.code !== 'OIDC_DISCOVERY_FAILED') {
      const wrapped = new Error(`issuer discovery at ${url} failed: ${err.message}`);
      wrapped.code = 'OIDC_DISCOVERY_FAILED';
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!doc || typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
    const err = new Error(`issuer discovery document at ${url} is missing authorization_endpoint/token_endpoint`);
    err.code = 'OIDC_DISCOVERY_FAILED';
    throw err;
  }
  const rejected =
    endpointRejection('authorization_endpoint', doc.authorization_endpoint) ||
    endpointRejection('token_endpoint', doc.token_endpoint);
  if (rejected) {
    const err = new Error(`issuer discovery document at ${url} is not usable: ${rejected}`);
    err.code = 'OIDC_ENDPOINT_NOT_ALLOWED';
    throw err;
  }
  return doc;
}

/**
 * @param {object} deps
 * @param {import('./registry').Registry} deps.registry
 * @param {import('./tokens').TokenStore} deps.tokens
 * @param {{patch: Function, remove: Function}} [deps.tokenWriter]
 *        supplied only when the "Renew now" button is enabled
 * @param {{patch: Function, remove: Function}} [deps.clusterWriter]
 *        supplied only when onboarding is enabled
 * @param {{last: object, runOnce: Function}} [deps.renewer]
 *        the in-process renewal clock, so /tokens can report when it last swept
 * @param {Cache} [deps.cache]
 * @param {Function} [deps.listFn] transport override. Development-mode fixtures set this
 *        so the real collectors still do the real transformation over fake raw objects.
 * @param {Function} [deps.textFn] the same seam for log text, which is not JSON and so
 *        travels through its own transport.
 * @param {Function} [deps.callFn] the same seam for onboarding, which writes rather than
 *        reads and so does not go through the collectors. Development-mode fixtures set it
 *        to make the "Add cluster" dialog reachable without a cluster to write to.
 */
function createRouter({ registry, tokens, tokenWriter, clusterWriter, renewer, cache = new Cache({ backgroundScope: withLowPriority }), listFn, textFn, callFn }) {
  const router = express.Router();

  /**
   * Every cache read in this router, so that `collectedAt` cannot drift from the body.
   *
   * The cache may serve an entry past its TTL while refreshing it behind the answer (see
   * `Cache` in fanout.js). That is the single change that took four-to-five seconds off the
   * sidebar poll, and the honesty cost of it is paid here: `onServed` reports when the served
   * value was *actually* collected, and `stamp(req)` returns the oldest such time across every
   * entry the request read. A response assembled from three cache entries is therefore dated
   * by its stalest ingredient, which is the only dating that cannot overstate freshness.
   *
   * Before this, `collectedAt` was `new Date()` at response time over a body that could
   * already be a full TTL old — the "Freshness" column and "collected 3s ago" were optimistic
   * by up to thirty seconds and said so to nobody.
   */
  const cached = (req, key, fn, opts = {}) =>
    cache.wrap(key, fn, {
      ...opts,
      onServed: at => {
        if (req._fleetCollectedAt === undefined || at < req._fleetCollectedAt) {
          req._fleetCollectedAt = at;
        }
      }
    });

  /** The collection time of the oldest cache entry this request served from. */
  const stamp = req => new Date(req._fleetCollectedAt ?? Date.now()).toISOString();

  // Threaded into every collector rather than baked into each call site, so that the
  // production path and the fixture path differ in exactly one place: the transport.
  // callFn rides alongside listFn here (not only in onboardExtras below) because a
  // collector under absentList's group-discovery probe (networking.js) needs the same
  // fixture transport a test wires in — without it, a fixture/test run sees no callFn and
  // silently falls back to the real k8s.call, diverging from what listFn already faked.
  const ctxExtras = listFn ? { listFn, ...(callFn ? { callFn } : {}) } : {};
  /** The same idea for the write path. Omitted entirely so the module default is used. */
  const onboardExtras = callFn ? { callFn } : {};

  /**
   * Turn any thrown error into a JSON body, never an HTML stack trace — and honour the
   * caller's `x-fleet-priority: low` hint.
   *
   * The hint is a **demotion only**. `low` is the one value that does anything and the only
   * thing it can do is make the sender's own reads queue behind everybody else's, so an
   * unauthenticated header nobody validates cannot be used to jump the per-cluster gate.
   * There is deliberately no way to ask for *more* than the default.
   *
   * The browser sets it on speculative tab prefetches. Without it a prefetch sweep and the
   * tab the operator actually clicked compete for the same eight slots, and warming the
   * pages nobody is looking at slows down the one they are — the exact inversion the
   * low-priority tier was added to prevent for the sidebar's `/summary` poll.
   */
  const wrap = fn => (req, res, next) => {
    const run = () => Promise.resolve(fn(req, res, next)).catch(next);
    return req.get('x-fleet-priority') === 'low' ? withLowPriority(run) : run();
  };

  const requireCluster = req => {
    const cluster = registry.get(req.params.id);
    if (!cluster) {
      const err = new Error(`unknown cluster: ${req.params.id}`);
      err.status = 404;
      // Without this the error middleware's fallback labels it `INTERNAL` — a 404 that reads as
      // "the dashboard broke". The console shows the code, and the commonest way to reach this is
      // to remove a cluster in one tab and refresh a detail page for it in another, where the
      // honest answer is that the cluster is gone, not that anything failed.
      err.code = 'NOT_FOUND';
      throw err;
    }
    return cluster;
  };

  /**
   * Which credential reaches a cluster. Stated here because fanout.js states it too, and
   * the two disagreeing would mean a cluster read as the signed-in user down one path and
   * as the service account down the other.
   */
  const isOidcCluster = c => c.authMode === 'oidc' || c.onboardedVia === 'oidc';

  /**
   * The caller's own bearer, read exactly as auth.js reads it. Undefined rather than null
   * when it is absent, so it never overrides a fallback further down.
   */
  const bearerFrom = req => {
    const header = (req && req.headers && req.headers.authorization) || '';
    return header.startsWith('Bearer ') ? (header.slice(7) || undefined) : undefined;
  };

  /**
   * Every fan-out goes through here, so the caller's token travels with it — but only as far
   * as a cluster whose host an operator named in FLEET_OIDC_PASSTHROUGH_HOSTS.
   *
   * Calling fanOut directly still compiles and is exactly the bug the wrapper replaces: an
   * OIDC cluster then falls back to the service-account token without saying so. Passing the
   * bearer unconditionally, which is what this wrapper did before, is the worse bug: `apiUrl`
   * is attacker-supplied, so one registered cluster turns every other operator's dashboard
   * load into a delivery of their SSO bearer.
   */
  const runFanOut = ({ req, only, ...rest }) => {
    const inScope = registry.active().filter(c => !only || only.includes(c.id));
    const bearer = bearerFrom(req);
    const forwardTo = bearer ? inScope.filter(c => isOidcCluster(c) && passthroughAllowed(c)) : [];

    if (!forwardTo.length) return fanOut({ registry, tokens, only, ...rest });
    if (forwardTo.length === inScope.length) return fanOut({ registry, tokens, only, userToken: bearer, ...rest });

    // Mixed fleet. fanOut takes one userToken for a whole sweep, so two credentials mean two
    // sweeps — forwarding the bearer to all of them because one host is allowlisted is
    // precisely the leak this guards against. Results are put back in registry order so the
    // split is invisible to every caller.
    const forwardIds = new Set(forwardTo.map(c => c.id));
    return Promise.all([
      fanOut({ registry, tokens, only: [...forwardIds], userToken: bearer, ...rest }),
      fanOut({ registry, tokens, only: inScope.filter(c => !forwardIds.has(c.id)).map(c => c.id), ...rest })
    ]).then(([asCaller, asService]) => {
      const byId = new Map([...asCaller, ...asService].map(r => [r.cluster.id, r]));
      return inScope.map(c => byId.get(c.id)).filter(Boolean);
    });
  };

  /**
   * A cache key, widened to the caller as soon as the fleet holds an OIDC cluster.
   *
   * Those clusters are read with the signed-in user's own token, so the result is that
   * user's view of them, and serving it to the next operator would hand them access their
   * own RBAC does not grant. Token-mode clusters are read with the same service-account
   * credential for everybody, so while no OIDC cluster is registered the key stays shared
   * and one sweep still serves every open browser.
   */
  const scoped = (req, key) => (registry.active().some(isOidcCluster)
    ? `${key}|as:${(req.user && req.user.id) || 'anonymous'}`
    : key);

  /**
   * Direct (non-fan-out) access for the single-cluster routes that must fail loudly.
   * The OIDC rule matches the fan-out exactly: an SSO cluster is reached as the caller only
   * when its host is allowlisted for passthrough and a token was forwarded, and otherwise
   * falls back to the stored service-account one.
   */
  const tokenFor = (cluster, req) => {
    const oidc = isOidcCluster(cluster);
    const allowed = oidc && passthroughAllowed(cluster);
    const token = (allowed ? bearerFrom(req) : undefined) || tokens.tokenFor(cluster.id);
    if (!token) {
      throw new ClusterError(UNSEEDED, oidc
        ? `${cluster.id} is configured for OIDC SSO but has no usable credential: ` +
          (allowed
            ? 'no user session token was received'
            : `its host is not listed in ${OIDC_PASSTHROUGH_HOSTS_ENV}, so your session token is not forwarded to it`) +
          ', and no service-account token is stored for it'
        : `${cluster.id} has no token. Onboard it again, or seed one by hand: ` +
          `kubectl create token ${cluster.serviceAccount} -n ${cluster.namespace} --duration=24h`,
        { cluster: cluster.id });
    }
    return token;
  };

  /**
   * Does this caller hold the fleet admin scope?
   *
   * auth.js grants it to members of FLEET_ADMIN_GROUPS (and to the local-development
   * identity). A qualified `<app>.${SCOPE}` spelling is also accepted, and the comparison is
   * on the qualified suffix rather than a substring — `tenant.evil-fleet-admin` must not
   * pass, and it does not, because the dot is part of what has to match.
   */
  const hasAdminScope = req => {
    const scopes = (req && req.user && Array.isArray(req.user.scopes)) ? req.user.scopes : [];
    return scopes.some(s => typeof s === 'string' && (s === ADMIN_SCOPE || s.endsWith(`.${ADMIN_SCOPE}`)));
  };

  /**
   * The gate on every route that writes the cluster registry or a token.
   *
   * Onboarding is the entry point for the whole OIDC-passthrough attack — `apiUrl` is only
   * dangerous because anyone who can reach the API can set it — and removal and renewal are
   * privileged in their own right. Reaching /api/fleet at all requires a verified identity in
   * ALLOWED_GROUPS; changing the fleet additionally requires membership of FLEET_ADMIN_GROUPS.
   */
  const requireAdmin = (req, res, next) => {
    if (!adminScopeEnforced() || hasAdminScope(req)) return next();
    getLogger().warn(`[fleet-audit] DENIED ${req.method} ${req.originalUrl || req.path}: user=${(req.user && req.user.id) || 'anonymous'} lacks ${ADMIN_SCOPE}`);
    return res.status(403).json({
      code: 'MISSING_SCOPE',
      message: `this account lacks ${ADMIN_SCOPE}. Ask for membership of a group listed in FLEET_ADMIN_GROUPS.`
    });
  };

  if (!adminScopeEnforced()) {
    getLogger().warn(`[fleet] admin scope enforcement is OFF (${process.env.FLEET_AUTH === 'none'
      ? 'FLEET_AUTH=none'
      : 'FLEET_REQUIRE_ADMIN_SCOPE=false'}): any authenticated caller may onboard, remove and renew clusters`);
  }

  /**
   * Whether this cluster's *registration* can be deleted.
   *
   * One predicate, four call sites — `/clusters`, `/clusters/:id`, `/tokens` and the remove
   * handler's own 409. Three copies had already appeared and a UI that offers a control the
   * handler then refuses is worse than no control, so they now read the same function.
   *
   * A baked cluster comes from `clusters.json` inside the image: deleting its record would work
   * until the next pod restart put it straight back, so in production the answer is no and the
   * error says to edit the image instead.
   */
  const isRemovable = id => process.env.NODE_ENV !== 'production' || !registry.isBaked(id);
  // Print the passthrough state next to the other [fleet] startup lines rather than leaving
  // it to appear on whichever request happens to be first. A green deploy says nothing about
  // which credential the fleet is reading with; this line does.
  passthroughHosts();

  /**
   * Compress the JSON this API sends to its browser client.
   *
   * `k8s.js` already asks Kubernetes for gzip on the way *in* — that is a different hop, and it
   * was the one measured. On the way *out* the fleet API was sending every body uncompressed:
   * `/clusters/:id/overview` measured 417 kB, `/workloads` 367 kB, `/policy` 83 kB. On localhost
   * that costs nothing and hid for exactly that reason; over the internet through a reverse proxy it is
   * the dominant term in how long a tab takes to appear, and no amount of server-side caching
   * touches it. These bodies are repetitive JSON, so gzip returns roughly a tenth of the bytes.
   *
   * Written against `zlib` rather than adding the `compression` package: it is twenty lines, and
   * a new runtime dependency in the srv image is a bigger change than the thing it would do.
   *
   * Four properties this deliberately keeps:
   *
   *  - **Opt-in by the client.** Only a request whose `Accept-Encoding` names gzip is compressed;
   *    anything else takes the untouched `res.json` path. `curl` without `--compressed` therefore
   *    still shows a readable body, which is what every verification recipe in this repo assumes.
   *  - **`Vary: Accept-Encoding` on every response**, compressed or not. A shared cache that
   *    stored one variant without it would serve a gzipped body to a client that never asked.
   *  - **Small bodies stay plain.** Below `MIN_GZIP_BYTES` the framing costs more than it saves,
   *    and it keeps `/me`, the typed 404 and every error body trivially greppable.
   *  - **Failure falls back rather than failing.** If `JSON.stringify` or `gzip` throws, the
   *    original `res.json` sends the body uncompressed. A compression layer must never be able
   *    to turn a successful read into an error response.
   *
   * It is the router's first middleware because it wraps `res.json` for everything downstream —
   * including the fallthrough handlers in json-boundary.js, which share this same `res`.
   */
  router.use((req, res, next) => {
    res.setHeader('Vary', 'Accept-Encoding');
    if (!/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return next();
    const plain = res.json.bind(res);
    res.json = body => {
      let text;
      try {
        text = JSON.stringify(body);
      } catch {
        return plain(body);
      }
      if (text === undefined || Buffer.byteLength(text) < MIN_GZIP_BYTES || res.getHeader('Content-Encoding')) {
        return plain(body);
      }
      zlib.gzip(text, (err, buf) => {
        if (err) {
          getLogger().error(`[fleet] gzip failed, sending plain JSON: ${err.message}`);
          return plain(body);
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(buf.length));
        res.end(buf);
      });
      // `res.json` returns the response in Express and a caller may chain off it; the send
      // itself finishes in the callback above.
      return res;
    };
    next();
  });

  // High-performance request and action audit logger
  router.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const user = req.user?.id || 'anonymous';
      getLogger().info(`[fleet-audit] ${req.method} ${req.originalUrl || req.path} -> ${res.statusCode} (${duration}ms) user=${user}`);
    });
    next();
  });

  // ---------------------------------------------------------------- clusters

  /**
   * The slot for a cluster the fan-out did not cover.
   *
   * Two populations land here and they are not the same answer:
   *
   *  - `enabled: false` — a deliberate configuration. The fleet is not reading it, and saying so
   *    is correct.
   *  - everything else — most often a cluster onboarded a moment ago, before this fan-out took
   *    its snapshot of the registry. It has not been read *yet*.
   *
   * Both used to return `ok: false`, and the rail renders that as a red "Unreachable — the fleet
   * could not read this cluster". So the first thing an operator saw after adding a cluster was a
   * confident failure verdict about a cluster nothing had contacted. `ok: null` is the third
   * state — unknown, not failed — and `notRead` says which of the two it is, so no screen has to
   * guess. It is deliberately not counted under `summary.unreachable`: an unmeasured cluster is
   * not an unreachable one, and the same rule that forbids turning a forbidden read into a zero
   * forbids turning an unfinished one into a failure.
   */
  function unreadSlot(c) {
    const disabled = c.enabled === false;
    return {
      cluster: publicCluster(c),
      ok: disabled ? false : null,
      registered: false,
      notRead: disabled ? 'disabled' : 'pending',
      token: tokens.health(c.id)
    };
  }

  router.get('/clusters', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'clusters'), () =>
      runFanOut({ req, collect: ctx => health.collect({ ...ctx, ...ctxExtras }) }));

    // Disabled clusters never reach the fan-out, but the UI still shows them as inactive
    // placeholders — so they are merged back in here rather than silently dropped.
    const activeIds = new Set(results.map(r => r.cluster.id));
    const placeholders = registry.all()
      .filter(c => !activeIds.has(c.id))
      .map(unreadSlot);

    res.json({
      summary: {
        clusters: results.length + placeholders.length,
        // `=== false` and not `!r.ok`: `null` is "not read yet", which is neither reachable nor
        // unreachable, and counting it here is what put a phantom failure on the fleet header.
        unreachable: [...results, ...placeholders].filter(r => r.ok === false).length,
        ...completenessUnion(results)
      },
      clusters: [...results, ...placeholders].map(r => ({
        ...r,
        // The fan-out entry keeps `data`, so the labels are reachable there too — but the UI
        // reads them off the slot itself, and every other fleet route puts them there.
        ...completenessOf(r),
        // In local development allow removing any cluster; in production only onboarded clusters
        removable: isRemovable(r.cluster.id)
      })),
      canOnboard: Boolean(clusterWriter && tokenWriter) && (!adminScopeEnforced() || hasAdminScope(req)),
      // The same pair of conditions `/tokens` reports, on the route the Overview actually calls.
      // Without it that page had to decide whether to offer a Remove control by guessing, and a
      // guess here is either a button that always 403s or a missing button on a fleet that can
      // remove. `removable` on each row above is the per-cluster half of the answer.
      canRemove: Boolean(clusterWriter && tokenWriter) && (!adminScopeEnforced() || hasAdminScope(req)),
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `cluster:${cluster.id}`), () =>
      runFanOut({ req, only: [cluster.id], collect: ctx => health.collect({ ...ctx, ...ctxExtras }) }));
    res.json({
      ...(result || unreadSlot(cluster)),
      removable: isRemovable(cluster.id),
      source: cluster.source,
      onboardedAt: cluster.onboardedAt,
      onboardedBy: cluster.onboardedBy
    });
  }));

  /**
   * Everything about one cluster in a single response — health, compliance, workloads and
   * recent warnings. The per-cluster page would otherwise fire four requests and render
   * in four steps, which reads as a slow page even when it is a fast one.
   */
  router.get('/clusters/:id/overview', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `overview:${cluster.id}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: async ctx => {
          const base = { ...ctx, ...ctxExtras };
          const [h, c, w, e] = await Promise.all([
            health.collect(base),
            compliance.collect(base),
            workloads.collect(base),
            workloads.events({ ...base, limit: 25 })
          ]);
          // `events` stays the bare array every existing reader already maps over; the
          // envelope's completeness keys ride beside it under `eventsSummary`, which is the
          // shape `unavailableEntries`/`truncatedEntries` read. Purely additive: a client that
          // never looks at `eventsSummary` behaves exactly as before, and one that does can
          // finally tell "no warnings" from "the events read was refused".
          return {
            health: h,
            compliance: c,
            workloads: w,
            events: e.items,
            eventsSummary: {
              count: e.count,
              occurrences: e.occurrences,
              limit: e.limit,
              atLimit: e.atLimit,
              unavailable: e.unavailable,
              truncated: e.truncated
            }
          };
        }
      }));
    res.json(result || unreadSlot(cluster));
  }));

  router.get('/clusters/:id/namespaces', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `ns:${cluster.id}`), () =>
      runFanOut({ req, only: [cluster.id], collect: ctx => compliance.collect({ ...ctx, ...ctxExtras }) }));
    res.json(result);
  }));

  /**
   * Workloads for the whole cluster, or for a selected SET of namespaces.
   *
   * `?namespace=` may be repeated — `?namespace=a&namespace=b` — which is the OR a namespace
   * filter expresses; a comma-separated value means the same thing. `normaliseNamespaces` dedupes,
   * sorts and validates before the set reaches the cache key, so the two orderings a browser
   * might serialise are one entry rather than two half-warm ones.
   */
  router.get('/clusters/:id/workloads', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    let namespaces;
    try {
      namespaces = normaliseNamespaces(req.query.namespace);
    } catch (err) {
      // Answered here rather than let through to the collector, for the same reason
      // `/graph` checks its kind here: a throw inside the fan-out comes back as an
      // `ok: false` cluster envelope, which reads as an outage rather than as the client
      // having asked for something that is not a namespace name.
      return res.status(400).json({ code: 'INVALID_NAMESPACE', message: err.message });
    }
    const [result] = await cached(req, scoped(req, `wl:${cluster.id}:${namespaces.join(',') || '*'}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => workloads.collect({ ...ctx, ...ctxExtras, namespace: namespaces })
      }));
    res.json(result);
  }));

  /**
   * The dependency graph around one workload — ingress, Services, ReplicaSets, pods, HPAs,
   * and the ConfigMaps/Secrets its pod template reads.
   *
   * Read-only and fetched lazily on selection, which is why it is its own route rather than
   * seven more list calls inside `/workloads`: that one runs on every poll for every cluster.
   */
  const GRAPH_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
  router.get('/clusters/:id/workloads/:namespace/:kind/:name/graph', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const { namespace, kind, name } = req.params;
    // Checked here, not only in the collector: the collector's throw would be caught by the
    // fan-out and returned as an unreachable-cluster envelope, which reads as an outage
    // rather than as the client asking for a kind that does not exist.
    if (!GRAPH_KINDS.has(kind)) {
      return res.status(400).json({
        code: 'UNSUPPORTED_KIND',
        message: `kind must be one of ${[...GRAPH_KINDS].join(', ')}`
      });
    }
    const [result] = await cached(req, scoped(req, `wlgraph:${cluster.id}:${namespace}:${kind}:${name}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => workloads.graph({ ...ctx, ...ctxExtras, namespace, kind, name })
      }));
    // A workload that is genuinely gone answers 404, not a 200 carrying an error envelope:
    // this route is reached from a link, and a stale link must read "deleted" rather than
    // "cluster unreachable". Every other fleet route is a fan-out where one cluster's
    // failure must not fail the response; this one addresses a single named object.
    if (result && result.ok === false && result.error && result.error.code === 'NOT_FOUND') {
      return res.status(404).json(result.error);
    }
    res.json(result);
  }));

  router.get('/clusters/:id/events', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const ns = req.query.namespace || undefined;
    const [result] = await cached(req, scoped(req, `ev:${cluster.id}:${ns || '*'}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => workloads.events({ ...ctx, ...ctxExtras, namespace: ns })
      }));
    res.json(result);
  }));

  // -------------------------------------------------------------------- logs

  /** Pods and their containers, for the log viewer's pickers. Cheap, so cached briefly. */
  router.get('/clusters/:id/pods', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const ns = req.query.namespace || undefined;
    const [result] = await cached(req, scoped(req, `pods:${cluster.id}:${ns || '*'}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => logs.inventory({ ...ctx, ...ctxExtras, namespace: ns })
      }));
    res.json(result);
  }));

  /** What the API server says when it cannot serve a log from the live container. */
  const NOT_STARTED = /is waiting to start|ContainerCreating|PodInitializing|CrashLoopBackOff/i;

  /**
   * One container's log tail, falling back to the instance before the last restart.
   *
   * A crash-looping pod has no running container, so the API server answers the log
   * request with 400 "is waiting to start: CrashLoopBackOff" and the viewer shows an empty
   * pane at exactly the moment someone needs to read why it crashed. The output that
   * explains it belongs to the previous container, so fetch that instead — and say so in
   * the body, because a tail from a dead container reads as stale unless the UI labels it.
   */
  const tailWithFallback = async ({ cluster, req, ...rest }) => {
    const token = tokenFor(cluster, req);
    const fetchTail = previous =>
      logs.tail({ cluster, token, ...rest, previous, ...(textFn ? { textFn } : {}) });

    // An explicit ?previous=true already asks for the older instance; nothing sits behind
    // it to fall back to.
    if (req.query.previous === 'true') return { ...(await fetchTail(true)), fallback: null };

    let current = null;
    let notStarted = null;
    try {
      current = await fetchTail(false);
      if (current.lines.length) return { ...current, fallback: null };
    } catch (err) {
      if (!(err instanceof ClusterError && err.status === 400 && NOT_STARTED.test(err.message))) throw err;
      notStarted = err;
    }

    const older = await fetchTail(true).catch(() => null);
    if (older && older.lines.length) {
      return {
        ...older,
        fallback: {
          showing: 'previous',
          reason: notStarted ? notStarted.message : 'the current container has produced no output yet'
        }
      };
    }

    // Nothing behind it either. The current container's own answer at least names the
    // reason, so report that rather than the empty second attempt.
    if (notStarted) throw notStarted;
    return { ...current, fallback: null };
  };

  /**
   * The log tail itself. Never cached, and deliberately not fan-out shaped: a log request
   * names one container on one cluster, and a failure to fetch it is a failure of the
   * request, not a degraded fleet.
   */
  router.get('/clusters/:id/logs', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const result = await tailWithFallback({
      cluster,
      req,
      namespace: req.query.namespace,
      pod: req.query.pod,
      container: req.query.container || undefined,
      tailLines: req.query.tailLines,
      sinceSeconds: req.query.sinceSeconds,
      timestamps: req.query.timestamps !== 'false'
    });
    res.json(result);
  }));

  // ----------------------------------------------------------- traffic errors

  /**
   * Istio 4xx/5xx read from Envoy access logs on `istio-proxy`.
   *
   * Cluster-only. There is deliberately no fleet-wide shape: this reads up to `MAX_PODS` pod
   * logs per call, so fanning it across a registry would multiply that by the cluster count
   * and turn one page view into a hundred log streams from the API servers.
   *
   * **Cached for seconds, not the usual thirty, and only until somebody asks for the live
   * tail.** This route used to refuse to cache at all, on the grounds that an operator
   * refreshing after a deploy must see the current tail rather than the one from before. That
   * reasoning is right and is preserved exactly — by the bypass, not by the refusal. What the
   * refusal actually cost was the *first* render: ten pod-log reads at 5-7s, paid again on
   * every single visit to the tab, including the one two seconds after the last.
   *
   * So:
   *   - an automatic read (mount, prefetch, a remount from a tab switch) inside
   *     `TRAFFIC_CACHE_TTL_MS` is served as is;
   *   - one after it, up to `TRAFFIC_CACHE_STALE_MS` further, is served from the entry at once
   *     while a background read replaces it. A cold read of this route is 8-20s and of
   *     `/traces` 11-33s (platformsbx, 2026-09-26), longer than the fresh window itself, so
   *     without the stale tail nearly every visit paid it. The two together serve an answer up
   *     to 10 minutes old (15s + 585s; the user's call, 2026-09-28, raised from 2 minutes).
   *     Every body is dated by its oldest log read (`collectedAt`), and the Proxies chip on both
   *     tabs prints it as "updated N min ago", so a served-stale answer says how old it is;
   *   - `cache-control: no-cache` — which the tab's own Refresh control sends, and nothing
   *     else does — skips the entry and reads the proxies again.
   *
   * `/traffic-errors` and `/traces` tail the same proxies, so both read through one `logShare`
   * (collectors/proxy-log-share.js): an interactive read may reuse a container tail up to the
   * serve bound old, a background refresh or a forced one never does.
   *
   * The key carries every parameter that changes the answer. Leaving `tailLines` out would
   * serve a 1000-line request from a 300-line read and report the wide window as satisfied.
   */
  const TRAFFIC_CACHE_TTL_MS = Number(process.env.FLEET_TRAFFIC_CACHE_TTL_MS || 15_000);
  const TRAFFIC_CACHE_STALE_MS = Number(process.env.FLEET_TRAFFIC_CACHE_STALE_MS || 585_000);
  /**
   * The oldest answer either route serves (10 minutes by default), and so the oldest shared tail an
   * interactive read takes and how long `logShare` keeps one. All three move together
   * (server/fleet/__tests__/traffic-cache-window.test.js).
   */
  const TRAFFIC_MAX_AGE_MS = TRAFFIC_CACHE_TTL_MS + TRAFFIC_CACHE_STALE_MS;
  const logShare = createLogShare({ retainMs: TRAFFIC_MAX_AGE_MS });
  /** One egress registry per cluster and credential for both routes; see collectors/registry-share.js. */
  const registryShare = createRegistryShare();
  const trafficCacheOpts = {
    ttlMs: TRAFFIC_CACHE_TTL_MS,
    staleMs: TRAFFIC_CACHE_STALE_MS,
    collectedAtOf: results => {
      const stamps = (results || []).map(r => Date.parse(r && r.data && r.data.collectedAt)).filter(Number.isFinite);
      return stamps.length ? Math.min(...stamps) : null;
    }
  };
  /** Reuse shared tails only on an interactive read; a refresh must tail the proxies. */
  const logReuse = (live, how) => ({
    logShare,
    registryShare,
    maxLogAgeMs: live || (how && how.revalidating) ? 0 : TRAFFIC_MAX_AGE_MS
  });

  router.get('/clusters/:id/traffic-errors', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const q = {
      namespace: req.query.namespace || undefined,
      tailLines: req.query.tailLines,
      maxPods: req.query.maxPods,
      sinceSeconds: req.query.sinceSeconds
    };
    // `no-store` is honoured alongside `no-cache` because a caller asking not to be *served*
    // a cached copy and one asking not to have one *kept* both mean "read it live" here.
    const directive = String(req.get('cache-control') || '').toLowerCase();
    const live = directive.includes('no-cache') || directive.includes('no-store');
    const read = how =>
      runFanOut({
        req,
        only: [cluster.id],
        collect: ctx =>
          traffic.collect({
            ...ctx,
            ...ctxExtras,
            ...(textFn ? { textFn } : {}),
            ...q,
            ...logReuse(live, how)
          })
      });

    // Invalidate *then* wrap, rather than reading around the cache. Skipping it entirely was
    // the first version, and it threw the fresh answer away: the refresh worked, and the very
    // next automatic read a render later re-collected and could show something different
    // again. A forced refresh must replace what is stored, not bypass it.
    const trafficCacheKey = scoped(req, `traffic:${cluster.id}:${JSON.stringify(q)}`);
    if (live) cache.invalidate(trafficCacheKey);
    const [result] = await cached(req, trafficCacheKey, read, trafficCacheOpts);
    res.json(result);
  }));

  /**
   * Distributed traces — the same pod-log read as `traffic-errors`, stitched into journeys.
   *
   * Cluster-only, for the identical reason: it tails up to `MAX_PODS` logs per call, and a
   * fleet-wide shape would multiply that by the registry.
   *
   * Two routes, **one cache entry**. The detail route recomputes nothing and re-reads nothing — it
   * awaits the same key the list route writes and picks one trace out of the result. That is not an
   * optimisation: a second log read would tail a *different* window, which can legitimately no
   * longer contain the trace the operator just clicked, and the drawer would explain a moving log
   * as a missing trace. `pickTrace` reports `NOT_IN_WINDOW` when the shared window really has
   * aged past it.
   */
  const tracesQuery = req => ({
    namespace: req.query.namespace || undefined,
    polls: req.query.polls === 'show' ? 'show' : undefined,
    tailLines: req.query.tailLines,
    maxPods: req.query.maxPods,
    sinceSeconds: req.query.sinceSeconds
  });

  const tracesRead = (req, cluster, q) => {
    const directive = String(req.get('cache-control') || '').toLowerCase();
    const live = directive.includes('no-cache') || directive.includes('no-store');
    const read = how =>
      runFanOut({
        req,
        only: [cluster.id],
        collect: ctx => traces.collect({ ...ctx, ...ctxExtras, ...(textFn ? { textFn } : {}), ...q, ...logReuse(live, how) })
      });
    // Named, and named uniquely: the key is needed twice — to invalidate on a forced re-read and
    // to wrap — and `server/fleet/__tests__/router.test.js` only accepts a local whose name is bound exactly
    // once in this file by `const … = scoped(`. A generic `key` is bound elsewhere and fails it.
    const tracesCacheKey = scoped(req, `traces:${cluster.id}:${JSON.stringify(q)}`);
    if (live) cache.invalidate(tracesCacheKey);
    return cached(req, tracesCacheKey, read, trafficCacheOpts);
  };

  router.get('/clusters/:id/traces', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await tracesRead(req, cluster, tracesQuery(req));
    res.json(result && result.ok === true && result.data ? { ...result, data: traces.listView(result.data) } : result);
  }));

  router.get('/clusters/:id/traces/:traceId', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await tracesRead(req, cluster, tracesQuery(req));
    // A failed cluster read stays exactly as the envelope reports it — picking a trace out of an
    // error would turn "this cluster did not answer" into "that trace does not exist".
    if (!result || result.ok !== true || !result.data) return res.json(result);
    res.json({ ...result, data: traces.pickTrace(result.data, req.params.traceId) });
  }));

  // -------------------------------------------------------------- compliance

  router.get('/compliance', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'compliance'), () =>
      runFanOut({ req, collect: ctx => compliance.collect({ ...ctx, ...ctxExtras }) }));

    const rows = results.flatMap(r => (r.ok ? r.data.namespaces : []));
    const audited = rows.filter(r => !r.system);
    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        audited: audited.length,
        compliant: audited.filter(r => r.verdict === 'compliant').length,
        withWarnings: audited.filter(r => r.verdict === 'warnings').length,
        withFindings: audited.filter(r => r.verdict === 'findings').length
      },
      clusters: results.map(r => clusterSlot(r)),
      namespaces: rows,
      collectedAt: stamp(req)
    });
  }));

  // --------------------------------------------------------------- workloads

  /** Every cluster's workloads in one sweep, for the fleet-wide Workloads page. */
  router.get('/workloads', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'workloads'), () =>
      runFanOut({ req, collect: ctx => workloads.collect({ ...ctx, ...ctxExtras }) }));

    const items = results.flatMap(r => (r.ok ? r.data.items : []));
    // Summed from each cluster's own collector-computed summary, not recomputed by
    // flattening `items` — workloads.js already did this exact arithmetic once, and a
    // second copy here is the anti-pattern this wave was meant to eliminate: it looks
    // identical today, and silently drifts the moment a future collector change (e.g. an
    // unavailable read that should propagate as a gap) makes `items` a partial list that no
    // longer matches its cluster's own `summary.total`.
    const okResults = results.filter(r => r.ok && r.data && r.data.summary);
    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        total: okResults.reduce((n, r) => n + r.data.summary.total, 0),
        notReady: okResults.reduce((n, r) => n + r.data.summary.notReady, 0),
        restarts: okResults.reduce((n, r) => n + r.data.summary.restarts, 0)
      },
      clusters: results.map(r => clusterSlot(r)),
      items,
      collectedAt: stamp(req)
    });
  }));

  /**
   * Rollout progress. A GET, and the only rollout route that remains.
   *
   * The `POST .../restart` and `POST .../scale` routes that used to bracket it are removed.
   * The fleet dashboard is a strictly read-only observability and investigation platform: it must never
   * mutate cluster state, so the write half of this surface is gone from the server as well as
   * the UI. Leaving the routes standing with no caller would have been a latent write path one
   * curl away, which is exactly the thing the read-only guarantee is supposed to rule out.
   */
  router.get('/clusters/:id/workloads/:namespace/:name/rollout', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const result = await actions.rolloutStatus({
      cluster,
      token: tokenFor(cluster, req),
      namespace: req.params.namespace,
      name: req.params.name,
      kind: req.query.kind || 'Deployment'
    });
    res.json(result);
  }));

  // --------------------------------------------------------------- networking

  router.get('/networking', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'networking'), () =>
      runFanOut({ req, collect: ctx => networking.collect({ ...ctx, ...ctxExtras }) }));

    const httproutes = results.flatMap(r => (r.ok ? (r.data.httproutes || []).map(x => ({ ...x, clusterId: r.cluster.id })) : []));
    const gateways = results.flatMap(r => (r.ok ? (r.data.gateways || []).map(x => ({ ...x, clusterId: r.cluster.id })) : []));
    const virtualservices = results.flatMap(r => (r.ok ? (r.data.virtualservices || []).map(x => ({ ...x, clusterId: r.cluster.id })) : []));
    const ingresses = results.flatMap(r => (r.ok ? (r.data.ingresses || []).map(x => ({ ...x, clusterId: r.cluster.id })) : []));
    const services = results.flatMap(r => (r.ok ? (r.data.services || []).map(x => ({ ...x, clusterId: r.cluster.id })) : []));

    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        totalHttpRoutes: httproutes.length,
        totalGateways: gateways.length,
        totalVirtualServices: virtualservices.length,
        totalIngresses: ingresses.length,
        totalServices: services.length
      },
      clusters: results.map(r => clusterSlot(r)),
      httproutes,
      gateways,
      virtualservices,
      ingresses,
      services,
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id/networking', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const ns = req.query.namespace || undefined;
    const [result] = await cached(req, scoped(req, `net:${cluster.id}:${ns || '*'}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => networking.collect({ ...ctx, ...ctxExtras, namespace: ns })
      }));
    res.json(result);
  }));

  // ------------------------------------------------------------------ storage

  router.get('/storage', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'storage'), () =>
      runFanOut({ req, collect: ctx => storage.collect({ ...ctx, ...ctxExtras }) }));

    const pvcs = results.flatMap(r => (r.ok ? (r.data.pvcs || []).map(p => ({ ...p, clusterId: r.cluster.id })) : []));
    const quotas = results.flatMap(r => (r.ok ? (r.data.quotas || []).map(q => ({ ...q, clusterId: r.cluster.id })) : []));

    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        totalPvcs: pvcs.length,
        boundPvcs: pvcs.filter(p => p.status === 'Bound').length,
        pendingPvcs: pvcs.filter(p => p.status === 'Pending').length,
        totalQuotas: quotas.length
      },
      clusters: results.map(r => clusterSlot(r)),
      pvcs,
      quotas,
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id/storage', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const ns = req.query.namespace || undefined;
    const [result] = await cached(req, scoped(req, `stor:${cluster.id}:${ns || '*'}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => storage.collect({ ...ctx, ...ctxExtras, namespace: ns })
      }));
    res.json(result);
  }));

  // ----------------------------------------------------------------- security

  router.get('/security', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'security'), () =>
      runFanOut({ req, collect: ctx => security.collect({ ...ctx, ...ctxExtras }) }));

    // `/security` splits reachable from unreachable rather than carrying `ok` on one list,
    // and keys the slot `clusterId`. Both are what the UI already reads, so neither changes
    // here — the two completeness lists are simply added in the same place as everywhere else.
    const items = results.filter(r => r.ok).map(r => ({
      clusterId: r.cluster.id,
      displayName: r.cluster.displayName || r.cluster.id,
      env: r.cluster.env,
      ...completenessOf(r),
      summary: r.data.summary,
      networkPolicies: r.data.networkPolicies,
      secretTypeDistribution: r.data.secretTypeDistribution
    }));

    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        ...completenessUnion(results)
      },
      clusters: items,
      unreachable: results.filter(r => !r.ok).map(r => ({ id: r.cluster.id, error: r.error, ...completenessOf(r) })),
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id/security', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `sec:${cluster.id}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => security.collect({ ...ctx, ...ctxExtras })
      }));
    res.json(result);
  }));

  // ----------------------------------------------------------------- autoscaling

  router.get('/autoscaling', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'autoscaling'), () =>
      runFanOut({ req, collect: ctx => autoscaling.collect({ ...ctx, ...ctxExtras }) }));

    const hpas = results.flatMap(r => (r.ok ? r.data.hpas : []));
    const cronjobs = results.flatMap(r => (r.ok ? r.data.cronjobs : []));

    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        totalHpas: hpas.length,
        totalCronJobs: cronjobs.length,
        activeCronJobs: cronjobs.filter(c => !c.suspend).length
      },
      clusters: results.map(r => clusterSlot(r)),
      hpas,
      cronjobs,
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id/autoscaling', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `as:${cluster.id}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => autoscaling.collect({ ...ctx, ...ctxExtras })
      }));
    res.json(result);
  }));

  // ----------------------------------------------------------------- certificates

  router.get('/certificates', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'certificates'), () =>
      runFanOut({ req, collect: ctx => certificates.collect({ ...ctx, ...ctxExtras }) }));

    const certs = results.flatMap(r => (r.ok ? r.data.certificates : []));
    const ingressTls = results.flatMap(r => (r.ok ? r.data.ingressTls : []));
    // `totalCertificates` is `null` on a cluster whose collector could reach neither
    // cert-manager nor Gardener certificates — flattening `certs` and counting its length
    // would read that refusal back as a confident 0, exactly the anti-pattern this wave
    // exists to remove. `null` propagates: the fleet total is `null` only when every
    // reachable cluster answered null too, and otherwise sums whatever real counts exist.
    const certTotals = results.filter(r => r.ok).map(r => (r.data && r.data.summary ? r.data.summary.totalCertificates : null));
    const totalCertificates = certTotals.length && certTotals.every(v => v === null)
      ? null
      : certTotals.reduce((n, v) => n + (v || 0), 0);

    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        totalCertificates,
        expiringSoon: certs.filter(c => c.isExpiringSoon).length,
        expired: certs.filter(c => c.isExpired).length,
        unready: certs.filter(c => !c.isReady).length
      },
      clusters: results.map(r => clusterSlot(r)),
      certificates: certs,
      ingressTls,
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id/certificates', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `cert:${cluster.id}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => certificates.collect({ ...ctx, ...ctxExtras })
      }));
    res.json(result);
  }));

  // ----------------------------------------------------------------- topology

  router.get('/topology', wrap(async (req, res) => {
    const results = await cached(req, scoped(req, 'topology'), () =>
      runFanOut({ req, collect: ctx => topology.collect({ ...ctx, ...ctxExtras }) }));

    const nodes = results.flatMap(r => (r.ok ? (r.data.nodes || []).map(n => ({ ...n, clusterId: r.cluster.id })) : []));
    const zones = results.flatMap(r => (r.ok ? r.data.zones : []));
    const nodeGroups = results.flatMap(r => (r.ok ? (r.data.nodeGroups || []) : []));

    // Aggregate node groups across clusters
    const groupMap = new Map();
    for (const g of nodeGroups) {
      if (!groupMap.has(g.name)) {
        groupMap.set(g.name, {
          name: g.name,
          nodeCount: 0,
          readyNodes: 0,
          instanceTypes: new Set(),
          zones: new Set(),
          podsScheduled: 0,
          podCapacity: 0,
          cpuAllocatable: 0,
          cpuRequested: 0,
          memoryAllocatable: 0,
          memoryRequested: 0
        });
      }
      const existing = groupMap.get(g.name);
      existing.nodeCount += g.nodeCount;
      existing.readyNodes += g.readyNodes;
      (g.instanceTypes || []).forEach(it => existing.instanceTypes.add(it));
      (g.zones || []).forEach(z => existing.zones.add(z));
      existing.podsScheduled += g.podsScheduled || 0;
      existing.podCapacity += g.podCapacity || 0;
      existing.cpuAllocatable += g.cpuAllocatable || 0;
      existing.cpuRequested += g.cpuRequested || 0;
      existing.memoryAllocatable += g.memoryAllocatable || 0;
      existing.memoryRequested += g.memoryRequested || 0;
    }

    const unifiedNodeGroups = Array.from(groupMap.values()).map(g => ({
      name: g.name,
      nodeCount: g.nodeCount,
      readyNodes: g.readyNodes,
      instanceTypes: [...g.instanceTypes],
      zones: [...g.zones].sort(),
      podsScheduled: g.podsScheduled,
      podCapacity: g.podCapacity,
      podUsagePercent: g.podCapacity ? Math.round((g.podsScheduled / g.podCapacity) * 1000) / 10 : null,
      cpuAllocatable: Math.round(g.cpuAllocatable * 100) / 100,
      cpuRequested: Math.round(g.cpuRequested * 100) / 100,
      cpuRequestedPercent: g.cpuAllocatable ? Math.round((g.cpuRequested / g.cpuAllocatable) * 1000) / 10 : null,
      memoryAllocatable: g.memoryAllocatable,
      memoryRequested: g.memoryRequested,
      memoryRequestedPercent: g.memoryAllocatable ? Math.round((g.memoryRequested / g.memoryAllocatable) * 1000) / 10 : null
    }));

    res.json({
      summary: {
        clusters: results.length,
        unreachable: results.filter(r => !r.ok).length,
        // The union of every in-scope cluster's labels, for a page showing a fleet total with
        // no per-cluster breakdown. The UI prefers the per-cluster lists on the slots in
        // `clusters` and only falls back to this one, so carrying both never double-counts.
        ...completenessUnion(results),
        totalNodes: nodes.length,
        readyNodes: nodes.filter(n => n.isReady).length,
        distinctZones: new Set(zones.map(z => z.zone)).size,
        distinctNodeGroups: unifiedNodeGroups.length,
        totalPodsScheduled: nodes.reduce((sum, n) => sum + (n.podsScheduled || 0), 0),
        totalPodCapacity: nodes.reduce((sum, n) => sum + (n.podCapacity || 0), 0)
      },
      clusters: results.map(r => clusterSlot(r, { data: r.data })),
      nodes,
      nodeGroups: unifiedNodeGroups,
      collectedAt: stamp(req)
    });
  }));

  router.get('/clusters/:id/topology', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const [result] = await cached(req, scoped(req, `topo:${cluster.id}`), () =>
      runFanOut({
        req, only: [cluster.id],
        collect: ctx => topology.collect({ ...ctx, ...ctxExtras })
      }));
    res.json(result);
  }));

  // -------------------------------------------------- the per-cluster group collectors

  /**
   * A generic fleet-wide + per-cluster route pair, for the collectors whose result is one
   * rich object per cluster rather than a handful of flat lists worth flattening into a
   * fleet-level table (the way /networking or /storage do for ingresses or pvcs). Each
   * cluster's whole `data` rides on its slot via `clusterSlot(r, { data: r.data })` — the
   * UI reads the real per-cluster payload, and no count is ever recomputed here, so there
   * is nothing for this route to get out of sync with the collector's own summary.
   *
   * `${cacheKey}:<id>` is also what both summaries (Part C) reuse, so a sidebar dot and the
   * cluster tab behind it are reading the exact same sweep rather than two independently-cached
   * ones that can disagree for up to `Cache`'s TTL. The fleet-wide entry, `cacheKey` itself, is
   * this route's alone.
   */
  function registerGroupRoutes(path, cacheKey, collect) {
    router.get(`/${path}`, wrap(async (req, res) => {
      const results = await cached(req, scoped(req, cacheKey), () =>
        runFanOut({ req, collect: ctx => collect({ ...ctx, ...ctxExtras }) }));
      res.json({
        summary: {
          clusters: results.length,
          unreachable: results.filter(r => !r.ok).length,
          ...completenessUnion(results)
        },
        clusters: results.map(r => clusterSlot(r, { data: r.data })),
        collectedAt: stamp(req)
      });
    }));

    router.get(`/clusters/:id/${path}`, wrap(async (req, res) => {
      const cluster = requireCluster(req);
      const [result] = await cached(req, scoped(req, `${cacheKey}:${cluster.id}`), () =>
        runFanOut({ req, only: [cluster.id], collect: ctx => collect({ ...ctx, ...ctxExtras }) }));
      res.json(result);
    }));
  }

  registerGroupRoutes('mesh', 'mesh', ctx => mesh.collect(ctx));

  registerGroupRoutes('capacity', 'capacity', ctx => capacity.collect(ctx));
  /**
   * Cost & budget. Deliberately NOT added to `SUMMARY_GROUPS` below: the sidebar sweep would
   * then pay for a node + pod read per cluster to compute money nobody asked for, and
   * `signals.js` requires a finding rule per summary group — a monthly spend is not a health
   * finding, and inventing a tone for it would put a warning pill on an expensive-but-healthy
   * cluster. The tab asks for this route directly.
   */
  registerGroupRoutes('cost', 'cost', ctx => cost.collect(ctx));
  registerGroupRoutes('reliability', 'reliability', ctx => reliability.collect(ctx));
  registerGroupRoutes('observability', 'observability', ctx => observability.collect(ctx));
  // Nested path on purpose: `helm` is a topic that will grow (history, diffs), and
  // `/clusters/:id/helm/releases` leaves room for siblings under it without renaming this one.
  registerGroupRoutes('helm/releases', 'helm-releases', ctx => helm.collect(ctx));

  /**
   * One release's rendered manifest and chart source, on request.
   *
   * A sibling under `helm/` rather than a field on the list response: measured live, the
   * manifests on one cluster total ~915 kB across 55 revisions, so carrying them in the list
   * would make every Helm tab open pay for content almost no one scrolls to. One release,
   * one click, one request.
   *
   * Everything crossing this wire is redacted in the collector — rendered Secret documents
   * lose their values, credential-shaped keys lose theirs everywhere. See helm.js.
   */
  router.get('/clusters/:id/helm/releases/:namespace/:name/manifest', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const { namespace, name } = req.params;
    const revParam = req.query.revision;
    // Validated here rather than coerced: `?revision=abc` silently becoming NaN would fall
    // through to "no such revision" and read as a deleted release rather than a bad link.
    if (revParam !== undefined && !/^\d+$/.test(String(revParam))) {
      return res.status(400).json({
        code: 'INVALID_REVISION',
        message: 'revision must be a positive integer'
      });
    }
    const revision = revParam === undefined ? null : Number(revParam);
    const [result] = await cached(req,
      scoped(req, `helm-manifest:${cluster.id}:${namespace}:${name}:${revision ?? 'deployed'}`),
      () => runFanOut({
        req, only: [cluster.id],
        collect: ctx => helm.manifest({ ...ctx, ...ctxExtras, namespace, name, revision })
      })
    );
    // Reached from a link, so a release that is gone answers 404 and reads as deleted rather
    // than as an unreachable cluster. Same rule as the workload graph route above.
    if (result && result.ok === false && result.error && result.error.code === 'NOT_FOUND') {
      return res.status(404).json(result.error);
    }
    res.json(result);
  }));

  /**
   * One release joined to what is actually running: the live inventory, the typed relationship
   * that proves each row belongs here, the relationship graph, and the release's events.
   *
   * Its own route, and lazily called, for the same reason as the manifest above — it is ~20
   * namespace-scoped lists, which is a fine cost once per release page and an unacceptable one
   * on the fleet sweep. `helm.collect()` stays as cheap as it was.
   */
  router.get('/clusters/:id/helm/releases/:namespace/:name/related', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const { namespace, name } = req.params;
    const [result] = await cached(req,
      scoped(req, `helm-related:${cluster.id}:${namespace}:${name}`),
      () => runFanOut({
        req, only: [cluster.id],
        collect: ctx => helmRelated.related({ ...ctx, ...ctxExtras, namespace, name })
      })
    );
    if (result && result.ok === false && result.error && result.error.code === 'NOT_FOUND') {
      return res.status(404).json(result.error);
    }
    res.json(result);
  }));

  /**
   * One live object, as redacted YAML — what the detail drawers open when an operator clicks a
   * node in the Helm Architecture graph or a row in Resources.
   *
   * ## Why it is a route of its own rather than a field on `/related`
   *
   * `/related` returns forty-odd resources for a release. Carrying every one of their full
   * objects would turn a 73 kB response into a multi-megabyte one to serve the single object the
   * operator eventually clicks — and would pay that cost on every release page open, clicked or
   * not. This is lazy by construction: nothing reads it until a drawer asks.
   *
   * ## Bounds
   *
   * `kind` is checked against `READABLE_KINDS` *before* any call, so an unknown Kind costs a 400
   * and no cluster traffic. Redaction happens in the collector, before serialisation — see the
   * header of `resource-yaml.js` for why each rule is there and which existing surface it
   * matches. Nothing here writes; `k8s.call` is a GET.
   */
  router.get('/clusters/:id/resource-yaml', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const namespace = typeof req.query.namespace === 'string' && req.query.namespace ? req.query.namespace : null;

    if (!resourceYaml.READABLE_KINDS.includes(kind)) {
      return res.status(400).json({
        code: 'UNSUPPORTED_KIND',
        message: `${kind || 'no kind'} is not a Kind this console reads. Readable: ${resourceYaml.READABLE_KINDS.join(', ')}`
      });
    }
    if (!name) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'name is required' });
    }

    const [result] = await cached(req,
      scoped(req, `res-yaml:${cluster.id}:${kind}:${namespace || '-'}:${name}`),
      () => runFanOut({
        req, only: [cluster.id],
        collect: ctx => resourceYaml.read({ ...ctx, ...ctxExtras, kind, namespace, name })
      })
    );
    // Reached from a link, so an object deleted since the graph was drawn answers 404 and reads
    // as deleted rather than as an unreachable cluster. Same rule as /related above.
    if (result && result.ok === false && result.error && result.error.code === 'NOT_FOUND') {
      return res.status(404).json(result.error);
    }
    res.json(result);
  }));

  router.get('/drift', wrap(async (req, res) => {
    // Reuse the exact cache entries /clusters and /workloads already mint for
    // the same cluster in the same request window, rather than minting drift's own
    // 'drift:health'/'drift:workloads' copies. A /report call that also hits /drift used
    // to trigger eight redundant reads per cluster for data already sitting in the cache;
    // sharing the key means whichever route asks first warms it for the other.
    const [healthRes, workloadsRes] = await Promise.all([
      cached(req, scoped(req, 'clusters'), () =>
        runFanOut({ req, collect: ctx => health.collect({ ...ctx, ...ctxExtras }) })),
      cached(req, scoped(req, 'workloads'), () =>
        runFanOut({ req, collect: ctx => workloads.collect({ ...ctx, ...ctxExtras }) }))
    ]);

    // 1. Cluster & K8s version parity
    const k8sVersionsFound = new Set();
    // Drift reads two collectors per cluster, so a cluster's completeness is the union of
    // both — a workload list that was refused makes the comparisons below partial just as
    // surely as a refused node list does.
    const driftCompleteness = id => completenessUnion(
      [...healthRes, ...workloadsRes].filter(r => r.cluster.id === id)
    );
    const clusterParity = healthRes.map(r => {
      const v = r.ok && r.data ? (r.data.kubernetesVersion || (r.data.kubernetesVersions && r.data.kubernetesVersions[0]) || 'unknown') : 'unreachable';
      if (r.ok && v !== 'unknown' && v !== 'unreachable') k8sVersionsFound.add(v);
      return {
        id: r.cluster.id,
        displayName: r.cluster.displayName || r.cluster.id,
        env: r.cluster.env,
        ok: r.ok,
        error: r.error || null,
        ...driftCompleteness(r.cluster.id),
        version: v,
        nodesTotal: r.data?.nodes?.total || 0,
        nodesReady: r.data?.nodes?.ready || 0,
        // Allocatable, not capacity — the number the scheduler divides up, and the one the
        // cluster's own detail page shows. Sending raw capacity here was how this table came
        // to print 16 cores / 64 GiB under an "Allocatable" header while ClusterDetail showed
        // 15.8 / 60 for the same nodes: the same contradiction health.js just fixed, spread
        // across two pages instead of one. Raw capacity has exactly one owner now — the
        // cluster health payload — and nothing on this page re-derives it.
        cpuAllocatable: r.data?.capacity?.cpu?.allocatable || 0,
        memoryAllocatable: r.data?.capacity?.memory?.allocatable || 0
      };
    });

    const primaryVersion = [...k8sVersionsFound][0] || null;
    const hasK8sDrift = k8sVersionsFound.size > 1;
    for (const cp of clusterParity) {
      cp.isDrifted = hasK8sDrift && cp.ok && cp.version !== primaryVersion;
    }

    // 2. Workload image drift
    const imageMap = new Map();
    for (const r of workloadsRes) {
      // workloads.js publishes its list at `items`, not `workloads` — this was silently
      // reading the wrong field and comparing against nothing on every call.
      if (!r.ok || !r.data || !r.data.items) continue;
      for (const w of r.data.items) {
        const key = `${w.namespace}/${w.name}`;
        if (!imageMap.has(key)) {
          imageMap.set(key, { name: w.name, namespace: w.namespace, kind: w.kind, clusterVersions: {} });
        }
        imageMap.get(key).clusterVersions[r.cluster.id] = {
          env: r.cluster.env,
          image: w.image,
          replicas: w.desired,
          ready: w.ready
        };
      }
    }

    const driftItems = Array.from(imageMap.values()).map(item => {
      const images = Object.values(item.clusterVersions).map(v => v.image).filter(Boolean);
      const isDrifted = new Set(images).size > 1;
      return { ...item, isDrifted };
    });

    res.json({
      summary: {
        totalWorkloadsCompared: driftItems.length,
        driftedWorkloadsCount: driftItems.filter(d => d.isDrifted).length,
        totalClusters: healthRes.length,
        unreachable: healthRes.filter(r => !r.ok).length,
        // Both sweeps, unioned: a drift verdict computed over a cluster whose workload list
        // was refused compares against nothing and would otherwise read as "no drift".
        ...completenessUnion([...healthRes, ...workloadsRes]),
        k8sVersions: [...k8sVersionsFound],
        hasK8sDrift
      },
      items: driftItems,
      clusterParity,
      collectedAt: stamp(req)
    });
  }));

  /**
   * The compliance collector reports counts, not a percentage — deriving one here
   * keeps the number and its denominator honest. A cluster with nothing auditable
   * scores 'n/a', never 100%: an empty cluster is not a compliant one.
   */
  const complianceScore = (data) => {
    if (!data || !data.summary) return 'N/A';
    const { audited, compliant } = data.summary;
    if (!audited) return 'n/a (no auditable namespaces)';
    return `${Math.round((compliant / audited) * 100)}% (${compliant}/${audited} namespaces)`;
  };

  /**
   * What the report can, and cannot, vouch for.
   *
   * Two different kinds of doubt are reported here, in two separate blocks, because folding
   * them together would destroy the distinction the collectors went to the trouble of drawing:
   *
   *   unavailable  the read did not happen. Whatever it would have counted is missing from
   *                the figures above, so a 0 there is not a measurement.
   *   truncated    the read happened and its items are real, but it stopped at k8s.js's
   *                paging ceiling. The figure is a floor — "at least N", never "N".
   *
   * A truncated read reported as unavailable would throw away a true lower bound; an
   * unavailable read reported as truncated would claim a number we never obtained. Both lists
   * are published by the collectors at `data.summary.<key>` — reading them one level too high,
   * at `data.<key>`, makes them permanently empty and turns this section into an affirmative
   * claim that a silently-403'd read was a measured zero. Both paths are read so that a
   * collector growing either field elsewhere is not silently ignored.
   *
   * Not every collector keeps these lists, and the two are tracked independently: health,
   * compliance and workloads keep neither, while security, storage, networking, certificates,
   * autoscaling and topology keep both. So the scope sentence is written per key — crediting a
   * collector for completeness because it reports failed reads, while it silently truncates a
   * 20000-item list, would be exactly the overclaim this section exists to prevent. Which
   * collector tracks which key is detected from the data rather than hard-coded, so this
   * section starts crediting one the moment it gains a field — do not re-derive the list above
   * from this comment, which is a snapshot and will go stale again.
   *
   * Consequence for this route specifically: `/report` fans out health, compliance and
   * security, so `security` is the only one of its three that reports either key. An empty
   * array from health or compliance is silence, not a clean bill of health, and the per-key
   * scope sentence says so in as many words.
   *
   * A cluster that failed outright is a third case again, and it arrives without labels: a
   * collector may deliberately let a central read throw rather than degrade — topology.js does
   * exactly this when its node list is refused, on the grounds that `totalNodes: 0` publishes
   * a resilience finding that was never measured. That reaches us as `ok: false` with no
   * `unavailable` entry at all, so it is recorded here as the whole cluster being unread.
   *
   * Gaps are keyed by cluster id, not display name — two clusters may share a name, and
   * collapsing them into one row would hide one of them — and labels from every collector
   * merge into that one row rather than overwriting each other.
   *
   * @param {Array<{name: string, results: Array<object>}>} groups
   */
  const completenessLines = (groups) => {
    const gaps = new Map();
    const entryFor = (cluster) => {
      let entry = gaps.get(cluster.id);
      if (!entry) {
        entry = { name: cluster.displayName || cluster.id, unavailable: new Set(), truncated: new Set() };
        gaps.set(cluster.id, entry);
      }
      return entry;
    };

    const tracked = Object.fromEntries(COMPLETENESS_KEYS.map(k => [k, []]));
    const untracked = Object.fromEntries(COMPLETENESS_KEYS.map(k => [k, []]));
    for (const { name, results } of groups) {
      const reports = Object.fromEntries(COMPLETENESS_KEYS.map(k => [k, false]));
      for (const r of results) {
        if (!r || !r.cluster) continue;
        if (!r.ok) {
          // No labels exist for a cluster that threw, and inventing per-read ones would be
          // guesswork. "cluster unreachable" is the whole truth available about it.
          entryFor(r.cluster).unavailable.add('cluster unreachable');
          continue;
        }
        for (const key of COMPLETENESS_KEYS) {
          const list = (r.data && r.data.summary && r.data.summary[key]) || (r.data && r.data[key]);
          if (!Array.isArray(list)) continue;
          // Presence of the key is what earns a collector a place in `tracked`, not a
          // non-empty list: an empty one is a positive statement that nothing was missed.
          reports[key] = true;
          for (const label of list) {
            if (typeof label === 'string' && label.length) entryFor(r.cluster)[key].add(label);
          }
        }
      }
      for (const key of COMPLETENESS_KEYS) (reports[key] ? tracked : untracked)[key].push(name);
    }

    const CAVEATS = {
      unavailable: 'a zero may be a read that failed rather than a measured absence',
      truncated: 'a count may have stopped at the paging ceiling rather than being a total'
    };
    const HEADINGS = { unavailable: 'Failed reads', truncated: 'Truncated reads' };

    const scope = COMPLETENESS_KEYS.map(key => {
      const yes = tracked[key];
      const no = untracked[key];
      if (!yes.length) return `${HEADINGS[key]} are reported by no collector in this report: anywhere in it, ${CAVEATS[key]}.`;
      return `${HEADINGS[key]} are reported by: ${yes.join(', ')}.`
        + (no.length ? ` Not by: ${no.join(', ')} — in those sections ${CAVEATS[key]}.` : '');
    });

    const rows = key => [...gaps.values()]
      .filter(g => g[key].size)
      .map(g => `- **${mdCell(g.name)}**: ${[...g[key]].map(mdCell).join(', ')}`);

    const unread = rows('unavailable');
    const floored = rows('truncated');

    const body = [];
    if (unread.length) {
      body.push(
        'These resources could not be read, so they are absent from the counts above rather',
        'than genuinely zero:',
        ...unread
      );
    }
    if (floored.length) {
      if (body.length) body.push('');
      body.push(
        'These resources were read successfully but stopped at the client\'s paging ceiling.',
        'Counts derived from the reads below are a floor, not a total — the real figure is at',
        'least what is reported above:',
        ...floored
      );
    }
    if (!body.length) {
      body.push(untracked.unavailable.length || untracked.truncated.length
        ? 'No gaps were reported by the collectors that track completeness.'
        : 'Every collector reported successfully — every figure above is a measured value.');
    }

    return [...scope, '', ...body].join('\n');
  };

  router.get('/report', wrap(async (req, res) => {
    // Same cache keys as /clusters, /compliance and /security, so a /report generated right
    // after those pages load reuses the sweep already sitting in the cache instead of
    // re-reading all three collectors on every cluster from scratch.
    const [healthRes, complianceRes, securityRes] = await Promise.all([
      cached(req, scoped(req, 'clusters'), () =>
        runFanOut({ req, collect: ctx => health.collect({ ...ctx, ...ctxExtras }) })),
      cached(req, scoped(req, 'compliance'), () =>
        runFanOut({ req, collect: ctx => compliance.collect({ ...ctx, ...ctxExtras }) })),
      cached(req, scoped(req, 'security'), () =>
        runFanOut({ req, collect: ctx => security.collect({ ...ctx, ...ctxExtras }) }))
    ]);

    // Every cluster-supplied string below goes through mdCell: displayName and env are
    // request-body fields, and one carrying a newline would forge report lines for clusters
    // that do not exist. Counts and scores are computed here and need no escaping.
    const reportMarkdown = [
      `# Kubernetes Fleet Audit & Health Report`,
      `Generated at: ${new Date().toISOString()}`,
      `\n## Fleet Clusters Summary`,
      `Total Clusters: ${healthRes.length}`,
      `Reachable: ${healthRes.filter(r => r.ok).length}`,
      `Unreachable: ${healthRes.filter(r => !r.ok).length}`,
      `\n## Cluster Health Overview`,
      healthRes.map(h => `- **${mdCell(h.cluster.displayName || h.cluster.id)}** (${mdCell(h.cluster.env)}): ${h.ok ? 'HEALTHY' : 'DEGRADED'}`).join('\n'),
      `\n## Compliance Audit Findings`,
      complianceRes.map(c => `- **${mdCell(c.cluster.displayName || c.cluster.id)}**: Score ${complianceScore(c.data)}`).join('\n'),
      `\n## Security & Isolation Score`,
      // `networkPolicyIsolationScoreText`, not the raw number: the score is null when there were no
      // app namespaces to divide by, and gluing a `%` onto that rendered the literal `null%` in an
      // operator-facing report. The collector formats the figure for exactly this reason
      // (security.js:326-332) — a plain-text consumer must never re-derive it.
      securityRes.map(s => `- **${mdCell(s.cluster.displayName || s.cluster.id)}**: Isolation Score ${s.data && s.data.summary && s.data.summary.networkPolicyIsolationScoreText ? mdCell(s.data.summary.networkPolicyIsolationScoreText) : 'N/A'}`).join('\n'),
      `\n## Data Completeness`,
      completenessLines([
        { name: 'health', results: healthRes },
        { name: 'compliance', results: complianceRes },
        { name: 'security', results: securityRes }
      ])
    ].join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fleet-report.md"');
    res.send(reportMarkdown);
  }));

  // ----------------------------------------------------------------------- summary

  /**
   * Every feature group this dashboard has, backing the sidebar's per-group state dots and the
   * per-cluster Overview tab.
   *
   * Two cache keys per group, and both matter:
   *
   * - `cacheKey` is the key the group's **fleet-wide** route caches under. Neither summary reads
   *   it: `summarizeGroups` reads per cluster, so `GET /summary` leaves that entry cold, and
   *   `${cacheKey}:${id}` is the per-cluster default below.
   * - `clusterKey(id)` is the key the group's **per-cluster** route already caches under. These
   *   are not `${cacheKey}:${id}` for the nine hand-written routes — `/clusters/:id` uses
   *   `cluster:`, compliance uses `ns:`, workloads `wl:…:*`, networking `net:…:*`, storage
   *   `stor:…:*`, security `sec:`, autoscaling `as:`, certificates `cert:`, topology `topo:` —
   *   and getting one wrong is not a cosmetic mistake: it would open a *third* cache entry per
   *   group and re-issue every read the tab is about to issue anyway. Only the eight
   *   `registerGroupRoutes` collectors use the `${cacheKey}:${id}` default.
   *
   * The consequence worth stating: opening a cluster's Overview warms the cache for every tab
   * behind it, so the tab that a tile links to renders from the same sweep the tile summarised
   * rather than from a second one that could disagree.
   */
  const SUMMARY_GROUPS = [
    { key: 'health', cacheKey: 'clusters', clusterKey: id => `cluster:${id}`, collect: ctx => health.collect(ctx) },
    { key: 'compliance', cacheKey: 'compliance', clusterKey: id => `ns:${id}`, collect: ctx => compliance.collect(ctx) },
    { key: 'workloads', cacheKey: 'workloads', clusterKey: id => `wl:${id}:*`, collect: ctx => workloads.collect(ctx) },
    { key: 'networking', cacheKey: 'networking', clusterKey: id => `net:${id}:*`, collect: ctx => networking.collect(ctx) },
    { key: 'storage', cacheKey: 'storage', clusterKey: id => `stor:${id}:*`, collect: ctx => storage.collect(ctx) },
    { key: 'security', cacheKey: 'security', clusterKey: id => `sec:${id}`, collect: ctx => security.collect(ctx) },
    { key: 'autoscaling', cacheKey: 'autoscaling', clusterKey: id => `as:${id}`, collect: ctx => autoscaling.collect(ctx) },
    { key: 'certificates', cacheKey: 'certificates', clusterKey: id => `cert:${id}`, collect: ctx => certificates.collect(ctx) },
    { key: 'topology', cacheKey: 'topology', clusterKey: id => `topo:${id}`, collect: ctx => topology.collect(ctx) },
    { key: 'mesh', cacheKey: 'mesh', collect: ctx => mesh.collect(ctx) },
    { key: 'capacity', cacheKey: 'capacity', collect: ctx => capacity.collect(ctx) },
    { key: 'reliability', cacheKey: 'reliability', collect: ctx => reliability.collect(ctx) },
    { key: 'observability', cacheKey: 'observability', collect: ctx => observability.collect(ctx) }
  ];

  /**
   * 'ok' only when every in-scope cluster answered and none of them reported a failed
   * read; 'error' when none did; 'degraded' for anything in between (some clusters ok,
   * some not, or an ok cluster still missing a piece of itself). An empty fleet is 'ok' —
   * there being nothing to report is not the same as a report having failed — and is never
   * confused with the client-side 'unqueried' state, which this route has no way to know
   * about: that is "no request has reached this route yet," and cannot be modelled from
   * inside a response the route only sends once asked.
   */
  function groupState(results) {
    if (!results.length) return 'ok';
    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) return 'error';
    const { unavailable } = completenessUnion(results);
    return (okCount < results.length || unavailable.length) ? 'degraded' : 'ok';
  }

  /**
   * Best-effort 'is this resource type installed at all', read from whichever of a few
   * conventions a collector's own payload already uses (`installed`,
   * `prometheusOperator.installed`) — never guessed from a name or count.
   * `null` (unknown, not "present") whenever no cluster's data exposes the concept, or
   * clusters disagree, since "half the fleet has it" is not an absence.
   */
  function absentOf(results) {
    const ok = results.filter(r => r.ok);
    if (!ok.length) return null;
    const flags = ok.map(r => {
      const summary = (r.data && r.data.summary) || {};
      if (r.data && typeof r.data.installed === 'boolean') return !r.data.installed;
      if (r.data && r.data.prometheusOperator && typeof r.data.prometheusOperator.installed === 'boolean') {
        return !r.data.prometheusOperator.installed;
      }
      return null;
    });
    if (flags.every(f => f === true)) return true;
    if (flags.every(f => f === false)) return false;
    return null;
  }

  /**
   * Both summary routes, in one place: for every group, the verdicts for a given set of clusters.
   *
   * Reads are issued **per cluster**, through the cache key that cluster's own tab route uses, and
   * the results concatenated. That is what makes `groupState` see exactly the array it would have
   * seen from one fleet-wide sweep — the helpers all take a plain results array — while every read
   * lands in an entry a tab is about to want anyway. One consequence is worth stating plainly: the
   * *fleet-wide* group routes (`GET /workloads`, `/storage`, …) still cache under their own
   * `cacheKey`, so they are not shared with this. Unifying those is F100's job, and needs the
   * route-coverage gate to land first; this already removes the duplication on the hot path, which
   * is the per-cluster one every tab and every tile uses.
   *
   * @param {object} req
   * @param {string[]} only cluster ids to summarise
   * @param {{withStats?: boolean}} [opts] add each group's tile `stats` (one cluster only)
   */
  async function summarizeGroups(req, only, { withStats = false } = {}) {
    const groups = {};
    const perCluster = {};
    for (const id of only) perCluster[id] = {};

    await Promise.all(SUMMARY_GROUPS.map(async ({ key, cacheKey, clusterKey, collect }) => {
      const perClusterResults = await Promise.all(only.map(async id => {
        const at = clusterKey ? clusterKey(id) : `${cacheKey}:${id}`;
        return cached(req, scoped(req, at), () =>
          runFanOut({ req, only: [id], collect: ctx => collect({ ...ctx, ...ctxExtras }) }));
      }));

      // Per cluster first, so a rail dot can name which cluster is unhappy without a second call.
      only.forEach((id, i) => {
        const one = perClusterResults[i] || [];
        const reads = groupState(one);
        const signals = signalsOf(key, one);
        perCluster[id][key] = { state: reads, health: healthOf(reads, signals), signals };
      });

      const results = perClusterResults.flat();
      const { unavailable, truncated } = completenessUnion(results);
      const reads = groupState(results);
      const signals = signalsOf(key, results);
      groups[key] = {
        state: reads,
        health: healthOf(reads, signals),
        signals,
        unavailable,
        truncated,
        absent: absentOf(results)
      };
      // The Overview tile's headline and split bar, asked for by the per-cluster route only. The
      // fleet sweep behind the rail dots reads verdicts; keyed on the route rather than on
      // `only.length`, because a one-cluster fleet would otherwise ship stats on every poll.
      if (withStats) groups[key].stats = statsOf(key, results);
    }));

    return { groups, perCluster };
  }

  /**
   * The fleet-wide sweep behind the sidebar's status dots.
   *
   * Marked as background work, and it is the one route that should be. The console polls it
   * every 30 s whether or not anyone is looking at it, and a full seventeen-group sweep of
   * every cluster was measured holding the per-cluster gate for twenty seconds — long enough
   * that a tab opened during one spent most of its time queued rather than reading. At low
   * priority the sweep keeps two slots per cluster free for whatever the operator just
   * clicked, and yields the queue to it. It still warms the very cache entries those tabs
   * read, so demoting it makes the click faster without making the dots later.
   *
   * `GET /clusters/:id/summary` below is deliberately *not* demoted: that one is the Overview
   * tab an operator is looking at.
   */
  router.get('/summary', wrap(async (req, res) => {
    const { groups, perCluster } = await withLowPriority(() =>
      summarizeGroups(req, registry.active().map(c => c.id)));
    res.json({ groups, perCluster, collectedAt: stamp(req) });
  }));

  /**
   * The same verdicts, for one cluster — what the cluster Overview tab renders one tile from
   * apiece.
   *
   * Deliberately not a filter over `GET /summary`: that route covers the whole fleet, so
   * summarising one cluster through it would read every other cluster to throw the answers away.
   * `only: [cluster.id]` bounds every collector to the one subject, and each group reads through
   * the cache key its own per-cluster tab route already uses, so this response and the tab behind
   * any tile are the same sweep rather than two that can disagree for up to a TTL.
   */
  router.get('/clusters/:id/summary', wrap(async (req, res) => {
    const cluster = requireCluster(req);
    const { groups } = await summarizeGroups(req, [cluster.id], { withStats: true });
    res.json({ cluster: publicCluster(cluster), groups, collectedAt: stamp(req) });
  }));

  // ------------------------------------------------------------- onboarding

  /**
   * Add a cluster, by pasted service-account token, uploaded kubeconfig, or OIDC SSO.
   *
   * Admin-only. This is the write that makes `apiUrl` dangerous: it is the destination the
   * fleet's own credentialed client connects to, and — where passthrough is allowlisted —
   * the destination an operator's session token is sent to.
   */
  /**
   * May this onboarding request take over an id that already exists?
   *
   * Returns `null` to proceed, or `{status, body}` to answer with. All three onboarding paths go
   * through it, because the defect it closes was three copies of one check that only asked the
   * narrower question.
   *
   * What it used to be: `if (existing && registry.isBaked(id)) 409`. So an id baked into the image
   * was protected and every id an operator had *onboarded* was not. `POST /clusters` with a
   * matching name silently repointed a live cluster at a different `apiUrl` with a different
   * token — and the console then rendered the attacker's API server under the real cluster's name,
   * healthy, with the real cluster's history. With `FLEET_REQUIRE_ADMIN_SCOPE=false` — which is
   * how sbx runs today — every authenticated user could do it. Nothing in the response said a
   * cluster had been replaced, because as far as the code was concerned nothing had.
   *
   * Now an existing id is a 409 by default, and the only way past is an explicit `replace: true`
   * in the request body. That turns a silent overwrite into a deliberate one: the console asks
   * before sending it, the audit line below records it, and a request that did not mean to replace
   * anything cannot do so by accident.
   *
   * Two limits, stated rather than implied:
   *  - A baked id stays absolutely refused. `replace` does not open it.
   *  - Where the admin scope is not enforced, `replace: true` is available to any authenticated
   *    caller, because the whole route is. This makes the act deliberate and auditable; it does
   *    not make it privileged. The privilege gate is `FLEET_REQUIRE_ADMIN_SCOPE=true` and
   *    membership of FLEET_ADMIN_GROUPS, and only that.
   */
  function collisionRejection(id, body, req) {
    if (!registry.get(id)) return null;
    if (registry.isBaked(id)) {
      return {
        status: 409,
        body: { code: 'BAKED_CLUSTER', message: `${id} is defined in the image and cannot be replaced by an upload` }
      };
    }
    if (!body || body.replace !== true) {
      return {
        status: 409,
        body: {
          code: 'CLUSTER_EXISTS',
          message:
            `${id} is already onboarded. Replacing it repoints the fleet at a different API server ` +
            'under the same name — resend with "replace": true to confirm that is what you mean.',
          clusterId: id
        }
      };
    }
    getLogger().warn(
      `[fleet-audit] cluster '${id}' is being REPLACED (replace=true) by user=${(req && req.user && req.user.id) || 'anonymous'}`
    );
    return null;
  }

  /**
   * Onboard from a kubeconfig's own static credential — the third of `POST /clusters`'s
   * three ways in, and the one `POST /clusters/bootstrap-oidc` falls through to unchanged
   * when the uploaded kubeconfig turns out not to be an OIDC/exec one. Factored out so both
   * routes share one persistence path rather than one being a fork that could drift from
   * the other.
   *
   * Precondition: `clusterWriter`/`tokenWriter` are configured — checked by both callers
   * before this runs, and re-checked here so the function is safe to call on its own.
   */
  async function onboardFromKubeconfig(req, res, { name, kubeconfig, env, contextName, replace }) {
    if (!clusterWriter || !tokenWriter) {
      return res.status(501).json({
        code: 'ONBOARD_DISABLED',
        message: 'this deployment cannot write the cluster or token Secret, so it cannot onboard clusters'
      });
    }
    if (typeof kubeconfig !== 'string' || !kubeconfig.trim()) {
      return res.status(400).json({ code: 'NO_CREDENTIAL', message: '`kubeconfig` (the YAML file contents) is required' });
    }
    if (Buffer.byteLength(kubeconfig, 'utf8') > MAX_KUBECONFIG_BYTES) {
      return res.status(413).json({ code: 'TOO_LARGE', message: `kubeconfig exceeds ${MAX_KUBECONFIG_BYTES} bytes; that is not a kubeconfig` });
    }

    const id = toClusterId(name);
    const collision = collisionRejection(id, { replace }, req);
    if (collision) return res.status(collision.status).json(collision.body);
    forgetAgent(id);

    const parsed = parseKubeconfig(kubeconfig, { contextName });
    // The same sink reached by a different route: an uploaded kubeconfig carries a server
    // URL too, and it is no more trustworthy for having arrived inside YAML.
    const rejected = apiUrlRejection(parsed.apiUrl);
    if (rejected) return res.status(400).json(rejected);
    const candidate = {
      id,
      displayName: String(name).trim(),
      env: env || 'unknown',
      apiUrl: parsed.apiUrl,
      caData: parsed.caData,
      namespace: onboard.FLEET_NAMESPACE,
      serviceAccount: onboard.FLEET_SA,
      authMode: 'token',
      enabled: true
    };
    const result = await onboard.bootstrap({
      cluster: candidate,
      adminToken: parsed.token,
      ...onboardExtras
    });
    result.contextName = parsed.contextName;

    await tokenWriter.patch(id, {
      token: result.token,
      expiresAt: result.expiresAt,
      renewedAt: new Date().toISOString(),
      lastError: null
    });
    // One record, written and then echoed — see the note on the token path for why
    // answering with `candidate` misreported every new cluster as `baked`.
    const registered = {
      ...candidate,
      source: 'onboarded',
      kubernetesVersion: result.kubernetesVersion,
      contextName: result.contextName || null,
      authMode: 'token',
      onboardedVia: 'kubeconfig',
      renewable: true,
      onboardedAt: new Date().toISOString(),
      onboardedBy: (req.user && req.user.id) || null
    };
    await clusterWriter.patch(id, registered);

    registry.unremove(candidate.id);
    registry.invalidate();
    getLogger().info(`[fleet-audit] Cluster '${candidate.id}' (${candidate.displayName}) onboarded via kubeconfig by user=${req.user?.id || 'anonymous'}`);
    cache.invalidate();

    return res.status(201).json({
      cluster: publicCluster(registered),
      steps: result.steps,
      expiresAt: result.expiresAt,
      kubernetesVersion: result.kubernetesVersion,
      onboardedVia: 'kubeconfig',
      renewable: true,
      note: 'the cluster is registered; other replicas will pick it up within a minute'
    });
  }

  /**
   * Read a kubeconfig and say what it contains. Registers nothing, stores nothing,
   * contacts no cluster.
   *
   * This is the Add-Cluster page's preview: it is what lets the form state "this file is an
   * SSO kubeconfig for context X, it has a CA, and it carries no token — paste one" before
   * the operator commits to anything. The page could have parsed the YAML itself, and used
   * to; the cost was a second set of rules about CA decoding, context selection and
   * https-only living in the browser, drifting from the server's, and showing a confident
   * summary of a file the server would go on to read differently.
   *
   * Admin-gated like the other onboarding routes even though it writes nothing: it parses
   * attacker-controllable YAML, and there is no reason for that to be reachable by anyone
   * who could not onboard a cluster anyway.
   *
   * **Nothing in the response is a credential.** `hasStaticToken` reports whether a token
   * is in the file; the token, the CA PEM and the exec argv never come back. A page that
   * echoed the uploaded file's token would put it in every screenshot of this screen.
   */
  router.post('/clusters/kubeconfig/describe', requireAdmin, wrap(async (req, res) => {
    const { kubeconfig, contextName } = req.body || {};
    if (typeof kubeconfig !== 'string' || !kubeconfig.trim()) {
      return res.status(400).json({ code: 'NO_KUBECONFIG', message: '`kubeconfig` (the YAML file contents) is required' });
    }
    if (Buffer.byteLength(kubeconfig, 'utf8') > MAX_KUBECONFIG_BYTES) {
      return res.status(413).json({ code: 'TOO_LARGE', message: `kubeconfig exceeds ${MAX_KUBECONFIG_BYTES} bytes; that is not a kubeconfig` });
    }

    const described = describeKubeconfig(kubeconfig, { contextName });
    const rejected = apiUrlRejection(described.apiUrl);
    if (rejected) return res.status(400).json(rejected);

    res.json({
      apiUrl: described.apiUrl,
      contextName: described.contextName,
      contexts: described.contexts,
      defaultNamespace: described.defaultNamespace,
      // Presence, not the certificate. The CA is not secret, but the page has no use for
      // the bytes and sending them makes this response something to be careful with.
      caPresent: Boolean(described.caData),
      credential: described.credential,
      hasStaticToken: described.hasStaticToken,
      // Issuer only. The client id is not a secret either, but it is not the page's
      // business on this path — the bootstrap-oidc route is where it matters.
      oidcIssuer: described.execOidc ? described.execOidc.issuer : null,
      // What the operator has to do next, decided here so the page does not re-derive it
      // from a credential string and reach a different conclusion.
      needsToken: !described.hasStaticToken
    });
  }));

  router.post('/clusters', requireAdmin, wrap(async (req, res) => {
    if (!clusterWriter || !tokenWriter) {
      return res.status(501).json({
        code: 'ONBOARD_DISABLED',
        message: 'this deployment cannot write the cluster or token Secret, so it cannot onboard clusters'
      });
    }

    const { name, kubeconfig, token, apiUrl: bodyApiUrl, caData: bodyCaData, env, contextName } = req.body || {};
    const usingToken = typeof token === 'string' && token.trim().length > 0;
    const hasKubeconfig = typeof kubeconfig === 'string' && Boolean(kubeconfig.trim());

    if (!usingToken && !hasKubeconfig) {
      return res.status(400).json({
        code: 'NO_CREDENTIAL',
        message: 'either `token` (a service-account token) or `kubeconfig` (the YAML file contents) is required. ' +
          'For SSO/exec kubeconfigs with no static token, use POST /clusters/bootstrap-oidc instead.'
      });
    }

    // The kubeconfig path is identical to POST /clusters/bootstrap-oidc's fallback branch,
    // so it lives in one place rather than two.
    if (!usingToken) return onboardFromKubeconfig(req, res, { name, kubeconfig, env, contextName });

    // Both: an SSO/exec kubeconfig for the endpoint, a separately minted token for the
    // credential. This is the common case for a cluster whose admins log in through an
    // identity provider — the file has the API server and its CA and no usable credential,
    // the operator has a token and no reliable way to type a PEM into a form. The file's own
    // credential, whatever it is, is ignored: `token` is what authenticates.
    //
    // The parse happens here rather than in the browser on purpose. A second parser in the
    // page is a second set of rules about CA decoding, context selection and https-only, and
    // the two drift silently — the page shows a confident summary of a file the server reads
    // differently. One parser, and the preview the page renders comes from this same one via
    // POST /clusters/kubeconfig/describe.
    let apiUrl = bodyApiUrl;
    let caData = bodyCaData;
    let resolvedContext = null;
    if (hasKubeconfig) {
      if (Buffer.byteLength(kubeconfig, 'utf8') > MAX_KUBECONFIG_BYTES) {
        return res.status(413).json({ code: 'TOO_LARGE', message: `kubeconfig exceeds ${MAX_KUBECONFIG_BYTES} bytes; that is not a kubeconfig` });
      }
      const described = describeKubeconfig(kubeconfig, { contextName });
      apiUrl = described.apiUrl;
      caData = described.caData;
      resolvedContext = described.contextName;
    }

    const id = toClusterId(name);
    const collision = collisionRejection(id, req.body, req);
    if (collision) return res.status(collision.status).json(collision.body);

    forgetAgent(id);

    const claims = saToken.decode(token);
    const rejected = apiUrlRejection(apiUrl);
    if (rejected) return res.status(400).json(rejected);
    if (typeof caData !== 'string' || !caData.includes('BEGIN CERTIFICATE')) {
      return res.status(400).json({
        code: 'NO_CA',
        message: hasKubeconfig
          ? 'the kubeconfig\'s cluster entry has no certificate-authority-data, so the API server cannot be ' +
            'verified. Re-export it with the CA inlined: kubectl config view --raw --minify --flatten'
          : 'caData is required and must be a PEM certificate; without it the API server cannot be verified'
      });
    }

    const candidate = {
      id,
      displayName: String(name).trim(),
      env: env || 'unknown',
      apiUrl: apiUrl.replace(/\/+$/, ''),
      caData,
      namespace: claims.namespace,
      serviceAccount: claims.serviceAccount,
      authMode: 'token',
      enabled: true
    };
    const result = await saToken.adopt({ cluster: candidate, token, claims, ...onboardExtras });

    await tokenWriter.patch(id, {
      token: result.token,
      expiresAt: result.expiresAt,
      renewedAt: new Date().toISOString(),
      lastError: null
    });
    // One record, written and then echoed. `candidate` is the *input* — it has no
    // `source`, no `onboardedVia` and no `renewable` — so answering with
    // `publicCluster(candidate)` reported every freshly onboarded cluster as `baked`, and,
    // worse, as `renewable: true` even when adopt() had just told us the token cannot mint
    // its successor. Building the registered record once removes the chance of the write
    // and the response disagreeing at all.
    const registered = {
      ...candidate,
      source: 'onboarded',
      kubernetesVersion: result.kubernetesVersion,
      contextName: resolvedContext,
      authMode: 'token',
      onboardedVia: 'token',
      renewable: result.renewable,
      onboardedAt: new Date().toISOString(),
      onboardedBy: (req.user && req.user.id) || null
    };
    await clusterWriter.patch(id, registered);

    registry.unremove(candidate.id);
    registry.invalidate();
    getLogger().info(`[fleet-audit] Cluster '${candidate.id}' (${candidate.displayName}) onboarded via token by user=${req.user?.id || 'anonymous'}`);
    cache.invalidate();

    res.status(201).json({
      cluster: publicCluster(registered),
      steps: result.steps,
      expiresAt: result.expiresAt,
      kubernetesVersion: result.kubernetesVersion,
      onboardedVia: 'token',
      renewable: result.renewable,
      note: 'the cluster is registered; other replicas will pick it up within a minute'
    });
  }));

  /**
   * Onboard an SSO/exec kubeconfig with no static token (Approach D).
   *
   * Step 1 of 2: the browser posts the kubeconfig text here. If it turns out to carry a
   * plain token/exec-less credential after all, this falls through to the exact same
   * `onboardFromKubeconfig` path `POST /clusters` uses for a kubeconfig — additive, not a
   * fork: nothing about an already-working kubeconfig upload changes by posting it here
   * instead. Only a genuine `exec` OIDC kubeconfig gets the redirect treatment below.
   *
   * Step 2 of 2 is the callback route right after this one, which the issuer redirects to.
   *
   * The uploaded kubeconfig itself is used once, in this handler, to extract the issuer/
   * client id/apiUrl — never stored. No id_token exists yet at this point.
   */
  router.post('/clusters/bootstrap-oidc', requireAdmin, wrap(async (req, res) => {
    if (!clusterWriter || !tokenWriter) {
      return res.status(501).json({
        code: 'ONBOARD_DISABLED',
        message: 'this deployment cannot write the cluster or token Secret, so it cannot onboard clusters'
      });
    }
    const { name, kubeconfig, env, contextName, replace } = req.body || {};
    if (typeof kubeconfig !== 'string' || !kubeconfig.trim()) {
      return res.status(400).json({ code: 'NO_CREDENTIAL', message: '`kubeconfig` (the YAML file contents) is required' });
    }
    if (Buffer.byteLength(kubeconfig, 'utf8') > MAX_KUBECONFIG_BYTES) {
      return res.status(413).json({ code: 'TOO_LARGE', message: `kubeconfig exceeds ${MAX_KUBECONFIG_BYTES} bytes; that is not a kubeconfig` });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 'NO_NAME', message: '`name` is required' });
    }
    // Checked here as well as at the callback. The SSO round trip is a browser redirect out to the
    // issuer and back; telling the operator the name is taken *after* they have signed in wastes a
    // minute on a refusal we already knew about.
    const early = collisionRejection(toClusterId(name), req.body, req);
    if (early) return res.status(early.status).json(early.body);

    const { execOidc } = extractExecOidcParams(kubeconfig, { contextName });
    if (!execOidc) return onboardFromKubeconfig(req, res, { name, kubeconfig, env, contextName, replace });

    const apiUrlHost = hostOf(execOidc.apiUrl);
    const rejectedApiUrl = apiUrlRejection(execOidc.apiUrl);
    if (rejectedApiUrl) return res.status(400).json(rejectedApiUrl);
    // The exact same allowlist check the existing OIDC-passthrough read path enforces
    // (`hostAllowlisted`, shared with `passthroughAllowed`), applied here to both the
    // apiUrl and the issuer — an unlisted host is refused before any redirect is built.
    if (!hostAllowlisted(apiUrlHost)) {
      return res.status(403).json({
        code: 'OIDC_HOST_NOT_ALLOWLISTED',
        message: `${apiUrlHost} is not listed in ${OIDC_PASSTHROUGH_HOSTS_ENV}; an operator must add it before this cluster can be onboarded via SSO`
      });
    }
    const issuerHost = hostOf(execOidc.issuer);
    if (!hostAllowlisted(issuerHost)) {
      return res.status(403).json({
        code: 'OIDC_ISSUER_NOT_ALLOWLISTED',
        message: `${issuerHost || execOidc.issuer} is not listed in ${OIDC_PASSTHROUGH_HOSTS_ENV}; an operator must add it before this cluster can be onboarded via SSO`
      });
    }

    let discovery;
    try {
      discovery = await discoverOidc(execOidc.issuer);
    } catch (err) {
      // A refused endpoint is a 400: the issuer answered, the document is well-formed, and the
      // problem is that it nominates a host this deployment has not authorised. 502 would blame
      // the upstream for a decision made here, and send the operator to the wrong place.
      const status = err.code === 'OIDC_ENDPOINT_NOT_ALLOWED' ? 400 : 502;
      return res.status(status).json({ code: err.code || 'OIDC_DISCOVERY_FAILED', message: err.message });
    }

    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const nonce = base64url(crypto.randomBytes(16));
    const flowId = base64url(crypto.randomBytes(24));
    // The known blocker: this exact URI must be pre-registered on the OIDC client, or the
    // issuer will reject the redirect at step 2 — reported there as OIDC_ISSUER_ERROR,
    // never a silent hang.
    const redirectUri = oidcRedirectUri(req);

    pruneOidcFlows();
    oidcFlows.set(flowId, {
      verifier,
      nonce,
      clientId: execOidc.clientId,
      tokenEndpoint: discovery.token_endpoint,
      redirectUri,
      candidate: {
        id: toClusterId(name),
        name: String(name).trim(),
        env: env || 'unknown',
        apiUrl: execOidc.apiUrl.replace(/\/+$/, ''),
        caData: execOidc.caData || null,
          contextName: execOidc.contextName
      },
      createdBy: (req.user && req.user.id) || null,
      // Carried from step 1 rather than re-read at the callback: the callback's inputs arrive via
      // a redirect the issuer controls, and whether an existing cluster may be overwritten is not
      // a decision to hand to it.
      replace: (req.body && req.body.replace) === true,
      expiresAt: Date.now() + OIDC_FLOW_TTL_MS
    });

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', execOidc.clientId);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    // Deduplicated: `--oidc-extra-scope=openid` is routinely present in a kubelogin exec block
    // alongside the `openid` this adds unconditionally, and the naive concatenation sent
    // `scope=openid email openid`. Legal, but it is the kind of thing an identity provider's
    // admin reads as a bug in the client.
    authorizationUrl.searchParams.set('scope', [...new Set(['openid', ...(execOidc.extraScopes || [])])].join(' '));
    authorizationUrl.searchParams.set('state', flowId);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    getLogger().info(`[fleet-audit] OIDC bootstrap flow started for cluster candidate '${toClusterId(name)}' by user=${req.user?.id || 'anonymous'}`);
    res.status(202).json({
      flowId,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: new Date(oidcFlows.get(flowId).expiresAt).toISOString(),
      note: 'redirect the browser to authorizationUrl; the issuer calls back to ' +
        `${redirectUri}, which must already be registered as a redirect URI on the OIDC client`
    });
  }));

  /**
   * Step 2 of 2: the issuer redirects here with `code` and `state` (our flow id). The
   * authorization code is redeemed server-side, and the resulting id_token is used exactly
   * once, in memory, in the very next call — to mint the real 24h fleet-reader token via
   * the existing TokenRequest chain — and then goes out of scope. It is never written to
   * the token store, never logged, never returned to the browser.
   */
  router.get('/clusters/bootstrap-oidc/callback', requireAdmin, wrap(async (req, res) => {
    if (!clusterWriter || !tokenWriter) {
      return res.status(501).json({
        code: 'ONBOARD_DISABLED',
        message: 'this deployment cannot write the cluster or token Secret, so it cannot onboard clusters'
      });
    }

    pruneOidcFlows();
    const { code, state: flowId, error, error_description: errorDescription } = req.query;
    // The known blocker made concrete: an unregistered redirect_uri surfaces here as
    // `error=invalid_request` (or `unauthorized_client`, issuer-dependent) rather than a
    // code — reported by name, never a fabricated success.
    if (error) {
      return finishOidcCallback(req, res, 400, {
        code: 'OIDC_ISSUER_ERROR',
        message: `the issuer refused the request: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`
      }, { sso: 'failed', code: 'OIDC_ISSUER_ERROR', message: String(errorDescription || error) });
    }

    const flow = flowId && oidcFlows.get(String(flowId));
    if (!flow) {
      return finishOidcCallback(req, res, 400, {
        code: 'OIDC_FLOW_EXPIRED',
        message: 'this authorization flow is unknown or has expired (flows last a few minutes); restart onboarding'
      }, { sso: 'failed', code: 'OIDC_FLOW_EXPIRED', message: 'the sign-in took longer than five minutes, or was already used' });
    }
    oidcFlows.delete(String(flowId)); // one-shot: replaying a used or abandoned code is refused, not retried

    /**
     * The callback must be finished by the same person who started it.
     *
     * Without this the flow is a confused deputy: `state` is unguessable, but it is not secret
     * once it has been *sent to someone*. An operator could start a flow naming any cluster,
     * mail the authorization URL to a colleague who actually holds admin on that cluster, and
     * have the colleague's sign-in used — server-side, invisibly — to create the namespace,
     * ServiceAccount and ClusterRoleBinding there and hand the resulting token to the fleet. The
     * victim authenticates to their own IdP as usual and sees nothing unusual.
     *
     * So the identity on this request is compared to the one captured at step 1. Fails closed:
     * a null on one side and a name on the other is a mismatch, not a pass. With `FLEET_AUTH=none`
     * both sides are null and local development is unaffected.
     */
    const finisher = (req.user && req.user.id) || null;
    if (finisher !== (flow.createdBy || null)) {
      getLogger().warn(
        `[fleet-audit] Refused an OIDC callback finished by a different identity than started it `
        + `(started by ${flow.createdBy || 'anonymous'})`
      );
      return finishOidcCallback(req, res, 403, {
        code: 'OIDC_FLOW_NOT_YOURS',
        message: 'this sign-in was started by a different user; start onboarding again from your own session'
      }, { sso: 'failed', code: 'OIDC_FLOW_NOT_YOURS', message: 'this sign-in was started by a different user' });
    }

    if (!code) {
      return finishOidcCallback(req, res, 400,
        { code: 'OIDC_NO_CODE', message: 'the issuer did not return an authorization code' },
        { sso: 'failed', code: 'OIDC_NO_CODE', message: 'the issuer did not return an authorization code' });
    }

    let tokenResponse;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let resp;
      let payload;
      try {
        resp = await fetch(flow.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: flow.redirectUri,
            client_id: flow.clientId,
            code_verifier: flow.verifier
          }),
          signal: controller.signal,
          // Same reason as discovery's: the endpoint was allowlisted, a redirect target was not.
          // A 307/308 here would re-POST the code and the PKCE verifier to the Location host.
          redirect: 'error'
        });
        // Inside the timer, so a body that stalls after the headers is bounded by the same 10s.
        payload = await resp.json().catch(() => null);
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok || !payload) {
        const err = new Error(`token exchange at ${flow.tokenEndpoint} answered ${resp.status}`);
        err.code = 'OIDC_CODE_EXCHANGE_FAILED';
        throw err;
      }
      tokenResponse = payload;
    } catch (err) {
      // Always our own code: fetch's rejections carry foreign ones (an AbortError's `code` is the
      // number 20), which explainError cannot read. Only the endpoint and status reach the message.
      const message = err.code === 'OIDC_CODE_EXCHANGE_FAILED'
        ? err.message
        : err.name === 'AbortError'
          ? `token exchange at ${flow.tokenEndpoint} did not answer within 10s`
          : `token exchange at ${flow.tokenEndpoint} failed: ${err.message}`;
      return finishOidcCallback(req, res, 502,
        { code: 'OIDC_CODE_EXCHANGE_FAILED', message },
        { sso: 'failed', code: 'OIDC_CODE_EXCHANGE_FAILED', message });
    }

    const idToken = tokenResponse.id_token;
    if (!idToken) {
      return finishOidcCallback(req, res, 502,
        { code: 'OIDC_NO_ID_TOKEN', message: 'the issuer\'s token endpoint did not return an id_token' },
        { sso: 'failed', code: 'OIDC_NO_ID_TOKEN', message: 'the issuer returned no id_token' });
    }

    const cand = flow.candidate;
    // The flow captured the operator's intent at step 1, before the browser left for the issuer.
    // Re-reading it from the callback's query would let the redirect the issuer controls decide
    // whether an existing cluster gets replaced.
    const collision = collisionRejection(cand.id, { replace: flow.replace === true }, { user: { id: flow.createdBy } });
    if (collision) {
      return finishOidcCallback(req, res, collision.status, collision.body,
        { sso: 'failed', code: collision.body.code, message: collision.body.message });
    }
    forgetAgent(cand.id);

    const candidate = {
      id: cand.id,
      displayName: cand.name,
      env: cand.env,
      apiUrl: cand.apiUrl,
      caData: cand.caData,
      namespace: onboard.FLEET_NAMESPACE,
      serviceAccount: onboard.FLEET_SA,
      authMode: 'token',
      enabled: true
    };

    let result;
    try {
      // idToken is read here and nowhere else; it is not captured by any variable that
      // outlives this try block.
      result = await onboard.bootstrap({
        cluster: candidate,
        adminToken: idToken,
        ...onboardExtras
      });
    } catch (err) {
      return finishOidcCallback(req, res, 502, {
        code: 'OIDC_BOOTSTRAP_FAILED',
        message: `SSO succeeded but minting the fleet-reader token failed: ${err.message}`
      }, {
        sso: 'failed',
        code: 'OIDC_BOOTSTRAP_FAILED',
        // Worth spelling out rather than relaying the raw error: the operator signed in
        // successfully and is about to be told it failed, which reads as their credential being
        // rejected when it is almost always the RBAC not being in place on the target cluster.
        message: `signed in successfully, but minting the fleet-reader token on the cluster failed: ${err.message}`
      });
    }

    await tokenWriter.patch(candidate.id, {
      token: result.token,
      expiresAt: result.expiresAt,
      renewedAt: new Date().toISOString(),
      lastError: null
    });
    // One record, written and then echoed — see the note on the token path.
    const registered = {
      ...candidate,
      source: 'onboarded',
      kubernetesVersion: result.kubernetesVersion,
      contextName: cand.contextName || null,
      // authMode stays 'token': the credential this cluster is read with from now on is
      // the minted fleet-reader token, exactly like every other kubeconfig/token
      // onboarding — there is no ongoing OIDC session to fall back to. `onboardedVia`
      // records the history without reusing the literal 'oidc' value, which is what
      // `isOidcCluster` (this file) and fanout.js's own isOidc branch key off of to decide
      // whether a *live* user session token is expected on every future read; reusing it
      // here would misfile this cluster as still needing one, forever.
      authMode: 'token',
      onboardedVia: 'oidc-bootstrap',
      renewable: true,
      onboardedAt: new Date().toISOString(),
      onboardedBy: flow.createdBy
    };
    await clusterWriter.patch(candidate.id, registered);

    registry.unremove(candidate.id);
    registry.invalidate();
    getLogger().info(`[fleet-audit] Cluster '${candidate.id}' (${candidate.displayName}) onboarded via oidc-bootstrap by user=${flow.createdBy || 'anonymous'}`);
    cache.invalidate();

    finishOidcCallback(req, res, 201, {
      cluster: publicCluster(registered),
      steps: result.steps,
      expiresAt: result.expiresAt,
      kubernetesVersion: result.kubernetesVersion,
      onboardedVia: 'oidc-bootstrap',
      renewable: true,
      note: 'the cluster is registered as a normal token-authenticated cluster; other replicas will pick it up within a minute'
    }, { sso: 'connected', cluster: candidate.id });
  }));


  /**
   * Remove a cluster from the fleet.
   *
   * Local only: the token record and the cluster record are deleted here, and nothing is
   * touched on the target cluster. Deleting the fleet-reader identity remotely would need
   * a credential we deliberately no longer hold — and silently revoking access to someone
   * else's cluster is not a thing a dashboard should do on a button press.
   */
  const removeClusterHandler = async (req, res) => {
    const cluster = requireCluster(req);
    if (!isRemovable(cluster.id)) {
      return res.status(409).json({
        code: 'BAKED_CLUSTER',
        message: `${cluster.id} is defined in the image; remove it from server/fleet/clusters.json and rebuild`
      });
    }
    if (!clusterWriter || !tokenWriter) {
      return res.status(501).json({ code: 'ONBOARD_DISABLED', message: 'this deployment cannot write the cluster Secret' });
    }

    getLogger().info(`[fleet-audit] Removing cluster '${cluster.id}' by user=${req.user?.id || 'anonymous'}`);
    await clusterWriter.remove(cluster.id);
    await tokenWriter.remove(cluster.id);
    registry.remove(cluster.id);
    cache.invalidate();

    res.json({
      cluster: cluster.id,
      removed: true,
      leftBehind: `the ${onboard.FLEET_NAMESPACE} namespace, the ${onboard.FLEET_SA} account and its ClusterRole remain on ${cluster.id}. ` +
        `Remove them there with: kubectl delete ns ${onboard.FLEET_NAMESPACE}; kubectl delete clusterrole ${onboard.CLUSTER_ROLE}; kubectl delete clusterrolebinding ${onboard.CLUSTER_ROLE}`
    });
  };

  router.delete('/clusters/:id', requireAdmin, wrap(removeClusterHandler));
  router.post('/clusters/:id/remove', requireAdmin, wrap(removeClusterHandler));
  router.post('/clusters/:id/delete', requireAdmin, wrap(removeClusterHandler));

  // ------------------------------------------------------------------ tokens

  router.get('/tokens', wrap(async (req, res) => {
    // Never cached and never containing a token: this is the page an operator loads when
    // something is already wrong, and a 30s-stale expiry countdown would be a liability.
    res.json({
      renewIntervalHours: 12,
      tokenLifetimeHours: 24,
      canRenew: Boolean(tokenWriter),
      // The same two conditions the remove handler itself checks, answered before the operator
      // is shown a control: this deployment can write the cluster records at all, and this
      // account carries the admin scope. `removable` on each row adds the per-cluster half.
      canRemove: Boolean(clusterWriter && tokenWriter) && (!adminScopeEnforced() || hasAdminScope(req)),
      // The schedule now lives in this process, so its state is worth showing: an
      // operator looking at a stale expiry wants to know whether the clock is even
      // ticking before they start diagnosing the cluster.
      renewer: renewer
        // `sweepIntervalMs` is the real configured cadence, not the default: the UI used to
        // print "joins the next one, in under half an hour" from a hardcoded string, which a
        // deployment overriding FLEET_RENEW_INTERVAL_MS turned into a wrong sentence.
        ? { inProcess: true, sweepIntervalMs: renewer.intervalMs, ...renewer.last }
        : { inProcess: false, sweepIntervalMs: null, at: null, healthy: null, total: null, renewed: 0, error: null },
      clusters: registry.all().map(c => ({
        cluster: publicCluster(c),
        removable: isRemovable(c.id),
        ...tokens.health(c.id)
      })),
      checkedAt: new Date().toISOString()
    });
  }));

  router.post('/tokens/:id/renew', requireAdmin, wrap(async (req, res) => {
    const cluster = requireCluster(req);
    if (!tokenWriter) {
      return res.status(501).json({
        code: 'RENEW_DISABLED',
        message: 'this deployment cannot write the token Secret, so it cannot renew'
      });
    }
    const current = tokens.tokenFor(cluster.id);
    if (!current) {
      return res.status(409).json({
        code: 'UNSEEDED',
        message: `${cluster.id} has no token to renew from. Seed one: kubectl create token ${cluster.serviceAccount} -n ${cluster.namespace} --duration=24h`
      });
    }

    // Exactly the code path the automatic sweep takes. If the button used a different one
    // it would be able to report success against logic the schedule never exercises.
    getLogger().info(`[fleet-audit] Manual token renewal triggered for '${cluster.id}' by user=${req.user?.id || 'anonymous'}`);
    const minted = await mint({ cluster, currentToken: current });
    await tokenWriter.patch(cluster.id, {
      token: minted.token,
      expiresAt: minted.expiresAt,
      renewedAt: new Date().toISOString(),
      lastError: null
    });
    cache.invalidate();

    res.json({ cluster: cluster.id, expiresAt: minted.expiresAt, renewedBy: req.user && req.user.id });
  }));

  // ------------------------------------------------------------------- misc

  /**
   * The capability flags the console hides buttons on. `onboard` and `renew` now depend on
   * the admin scope as well as on the writer being configured — offering a button that is
   * guaranteed to answer 403 is a worse experience than not offering it.
   */
  router.get('/me', (req, res) => {
    const admin = !adminScopeEnforced() || hasAdminScope(req);
    const callback = ssoCallback(req);
    return res.json({
      ...(req.user || {}),
      admin,
      capabilities: {
        onboard: admin && Boolean(clusterWriter && tokenWriter),
        renew: admin && Boolean(tokenWriter)
        // `rollout` is gone with the restart and scale routes. This console is read-only, so
        // there is no rollout capability left to advertise.
      },
      // Not a capability — a fact the Add Cluster page has to be able to *show*. SSO onboarding
      // is blocked until an administrator registers this exact string on the identity provider's
      // client, and an operator who cannot read it off the screen has nothing to send them.
      ssoCallbackUrl: callback.url,
      // Whether the line above is a configured fact or a guess from this request. The console
      // prints the URI as the thing an admin must register on the IdP, and a guess that looks
      // like a fact is how an operator ends up registering an unreachable internal address.
      ssoCallbackUrlConfigured: callback.configured,
      // https, or http on loopback. A plain-http public callback is refused by most providers and
      // is a token-interception hazard where it is not — either way the console must say so
      // *before* an administrator spends a change window registering it.
      ssoCallbackUrlSecure: callback.secure,
      // Which of the three ways this could be wrong, so the console names the fix rather than
      // printing one generic warning over three different causes. Null when nothing is wrong.
      ssoCallbackUrlProblem: callback.problem
    });
  });

  router.use((err, req, res, _next) => {
    if (err instanceof KubeconfigError) return res.status(400).json({ code: err.code, message: err.message });
    if (err instanceof saToken.SaTokenError) return res.status(400).json({ code: err.code, message: err.message });
    if (err instanceof ClusterError) return res.status(502).json(err.toJSON());
    const status = err.status || 500;
    getLogger().error(`[fleet-error] [${req.method} ${req.originalUrl || req.path}] status=${status} code=${err.code || 'INTERNAL'} user=${req.user?.id || 'anonymous'}: ${err.stack || err.message}`);
    res.status(status).json({ code: err.code || 'INTERNAL', message: err.message });
  });

  return router;
}

export default { createRouter, MOUNT_PATH, MAX_KUBECONFIG_BYTES };
