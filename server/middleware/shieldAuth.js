import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getLogger } from '../logger.js';

const ALLOWED_GROUPS = [];
const DEFAULT_JWKS_URL = 'https://idmsac.apple.com/auth/oauth2/keys';

const jwksUrl = process.env.SHIELD_JWKS_URL || DEFAULT_JWKS_URL;
const jwks = createRemoteJWKSet(new URL(jwksUrl));

let warnedNoJwks = false;

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function getAllowedGroups() {
  const envGroups = process.env.ALLOWED_GROUPS || '';
  const combined = [...ALLOWED_GROUPS, ...envGroups.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !Number.isNaN(n))];
  return [...new Set(combined)];
}

export function shieldAuth(req, res, next) {
  return shieldAuthAsync(req, res, next);
}

async function shieldAuthAsync(req, res, next) {
  const log = getLogger();

  // Bypass in local dev
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  // Health probe must always pass
  if (req.path === '/api/health') {
    return next();
  }

  // Read token from Shield OIDC header or Authorization Bearer
  let token = req.headers['shield-oidc-id'];
  if (!token) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    log.warn({ path: req.path }, 'auth token missing');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let payload;

  try {
    const result = await jwtVerify(token, jwks);
    payload = result.payload;
  } catch (err) {
    const decoded = decodeJwtPayload(token);
    log.warn({ path: req.path, error: err.message, sub: decoded?.sub }, 'JWT verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check group membership
  const allowedGroups = getAllowedGroups();
  const userGroups = Array.isArray(payload.groups) ? payload.groups : [];
  const hasGroup = userGroups.some(g => allowedGroups.includes(g));

  if (!hasGroup) {
    log.warn({ path: req.path, sub: payload.sub, userGroups, allowedGroups }, 'user not in allowed groups');
    return res.status(403).json({ error: 'Forbidden' });
  }

  log.debug({ path: req.path, email: payload.email ?? payload.sub }, 'auth passed');
  req.user = { email: payload.email ?? payload.sub, groups: userGroups };
  next();
}
