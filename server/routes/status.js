import { Router } from 'express';
import { readCertStatus } from '../lib/certStatus.js';

// Narrative identity status. Paths come from the same env vars the Whisper
// client uses, which the chart points at the CSI mount (/tls).
export default function statusRoutes({ env = process.env, whisper = null } = {}) {
  const router = Router();

  router.get('/', async (req, res) => {
    let narrative;
    try {
      narrative = await readCertStatus({
        certPath: env.WHISPER_CLIENT_CERT_PATH,
        keyPath: env.WHISPER_CLIENT_KEY_PATH,
        caPath: env.WHISPER_CLIENT_CA_PATH,
      });
    } catch (err) {
      narrative = { status: 'fail', detail: err.message, leaf: null, chain: [], ca: [], keyMatches: null };
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      checkedAt: new Date().toISOString(),
      narrative,
      whisper: { loaded: whisper != null },
      runtime: { namespace: env.POD_NAMESPACE || null, pod: env.HOSTNAME || null, nodeEnv: env.NODE_ENV || 'development' },
    });
  });

  return router;
}
