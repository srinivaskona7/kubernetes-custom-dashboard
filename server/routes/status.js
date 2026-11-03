import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { authMode } from '../middleware/oidcAuth.js';

let PACKAGE_VERSION = '0.0.0';
try {
  PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || PACKAGE_VERSION;
} catch { /* running from a trimmed image; an unknown version beats a crashing route */ }

// Deployment status: what is running, how many clusters it knows, and how it authenticates.
// Deliberately carries nothing from the app config file — that may hold values nobody should
// read off an unauthenticated-looking status page.
export default function statusRoutes({ env = process.env, registry = null, version = PACKAGE_VERSION } = {}) {
  const router = Router();

  router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      version,
      clusters: registry ? registry.all().length : null,
      authMode: authMode(env),
    });
  });

  return router;
}
