import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import statusRoutes from '../routes/status.js';

let server;
afterEach(() => server?.close());

async function getStatus(options) {
  const app = express();
  app.use('/api/status', statusRoutes(options));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/status`);
  return { res, body: await res.json() };
}

describe('GET /api/status', () => {
  it('reports a missing certificate and runtime info without throwing', async () => {
    const { res, body } = await getStatus({
      env: { WHISPER_CLIENT_CERT_PATH: '/nonexistent/tls.crt', POD_NAMESPACE: 'ns', HOSTNAME: 'pod-1', NODE_ENV: 'production' },
      whisper: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.narrative.status).toBe('missing');
    expect(body.whisper).toEqual({ loaded: false });
    expect(body.runtime).toEqual({ namespace: 'ns', pod: 'pod-1', nodeEnv: 'production' });
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
  });

  it('reflects a loaded Whisper config', async () => {
    const { body } = await getStatus({ env: {}, whisper: { some: 'secret' } });
    expect(body.whisper).toEqual({ loaded: true });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
