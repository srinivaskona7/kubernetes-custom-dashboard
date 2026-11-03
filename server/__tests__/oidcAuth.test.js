import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createOidcAuth, authMode } from '../middleware/oidcAuth.js';

// Keys are generated in-process and handed to the middleware as a local JWKS, so no test
// fetches anything: the verification path is the real one, only the key source is swapped.

let signingKey;
let otherKey;
let jwks;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] });
});

function sign(claims, { key = signingKey, issuer, audience } = {}) {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m');
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  return jwt.sign(key);
}

/** Runs the middleware over a fake request and reports what it did. */
async function run(mw, { path = '/api/fleet/clusters', token } = {}) {
  const req = { path, headers: token ? { authorization: `Bearer ${token}` } : {} };
  let status = null;
  let body = null;
  let called = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await mw(req, res, () => { called = true; });
  return { req, status, body, called };
}

const OIDC = { AUTH_MODE: 'oidc', OIDC_JWKS_URL: 'https://idp.example.com/jwks' };

describe('authMode', () => {
  it('defaults to none outside production and to oidc in production', () => {
    expect(authMode({})).toBe('none');
    expect(authMode({ NODE_ENV: 'development' })).toBe('none');
    expect(authMode({ NODE_ENV: 'production' })).toBe('oidc');
  });

  it('an explicit AUTH_MODE wins, case-insensitively', () => {
    expect(authMode({ NODE_ENV: 'production', AUTH_MODE: 'None' })).toBe('none');
    expect(authMode({ AUTH_MODE: 'OIDC' })).toBe('oidc');
  });
});

describe('oidcAuth', () => {
  it('AUTH_MODE=none passes every request through without an identity', async () => {
    const out = await run(createOidcAuth({ env: { AUTH_MODE: 'none' }, jwks }));
    expect(out.called).toBe(true);
    expect(out.req.user).toBeUndefined();
  });

  it('/api/health always passes, even with no token', async () => {
    const out = await run(createOidcAuth({ env: OIDC, jwks }), { path: '/api/health' });
    expect(out.called).toBe(true);
  });

  it('a request with no bearer token is 401', async () => {
    const out = await run(createOidcAuth({ env: OIDC, jwks }));
    expect(out.called).toBe(false);
    expect(out.status).toBe(401);
  });

  it('a valid token sets req.user to { email, groups }', async () => {
    const token = await sign({ sub: 'u1', email: 'alice@example.com', groups: ['readers', 'admins'] });
    const out = await run(createOidcAuth({ env: OIDC, jwks }), { token });
    expect(out.called).toBe(true);
    expect(out.req.user).toEqual({ email: 'alice@example.com', groups: ['readers', 'admins'] });
  });

  it('falls back to sub when the token carries no email', async () => {
    const token = await sign({ sub: 'svc-1' });
    const out = await run(createOidcAuth({ env: OIDC, jwks }), { token });
    expect(out.req.user).toEqual({ email: 'svc-1', groups: [] });
  });

  it('a token signed by a key outside the JWKS is 401', async () => {
    const token = await sign({ sub: 'u1', email: 'mallory@example.com' }, { key: otherKey });
    const out = await run(createOidcAuth({ env: OIDC, jwks }), { token });
    expect(out.called).toBe(false);
    expect(out.status).toBe(401);
  });

  it('enforces OIDC_ISSUER and OIDC_AUDIENCE when set', async () => {
    const env = { ...OIDC, OIDC_ISSUER: 'https://idp.example.com', OIDC_AUDIENCE: 'fleet' };
    const good = await sign({ sub: 'u1' }, { issuer: 'https://idp.example.com', audience: 'fleet' });
    expect((await run(createOidcAuth({ env, jwks }), { token: good })).called).toBe(true);

    const wrongIssuer = await sign({ sub: 'u1' }, { issuer: 'https://evil.example.com', audience: 'fleet' });
    expect((await run(createOidcAuth({ env, jwks }), { token: wrongIssuer })).status).toBe(401);

    const wrongAudience = await sign({ sub: 'u1' }, { issuer: 'https://idp.example.com', audience: 'other' });
    expect((await run(createOidcAuth({ env, jwks }), { token: wrongAudience })).status).toBe(401);
  });

  it('requires ALLOWED_GROUPS membership only when ALLOWED_GROUPS is set', async () => {
    const token = await sign({ sub: 'u1', email: 'bob@example.com', groups: ['readers'] });

    const open = await run(createOidcAuth({ env: OIDC, jwks }), { token });
    expect(open.called).toBe(true);

    const member = await run(createOidcAuth({ env: { ...OIDC, ALLOWED_GROUPS: 'ops, readers' }, jwks }), { token });
    expect(member.called).toBe(true);

    const outsider = await run(createOidcAuth({ env: { ...OIDC, ALLOWED_GROUPS: 'ops' }, jwks }), { token });
    expect(outsider.called).toBe(false);
    expect(outsider.status).toBe(403);
  });

  it('refuses every request when oidc mode has no JWKS URL, rather than letting one through', async () => {
    const out = await run(createOidcAuth({ env: { AUTH_MODE: 'oidc' } }));
    expect(out.called).toBe(false);
    expect(out.status).toBe(503);
  });
});
