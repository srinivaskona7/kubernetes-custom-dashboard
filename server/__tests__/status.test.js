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
  it('reports exactly ok, version, clusters and authMode', async () => {
    const registry = { all: () => [{ id: 'a' }, { id: 'b' }] };
    const { res, body } = await getStatus({ env: { NODE_ENV: 'production', AUTH_MODE: 'oidc' }, registry, version: '1.2.3' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ ok: true, version: '1.2.3', clusters: 2, authMode: 'oidc' });
  });

  it('reports authMode none outside production by default, and null clusters with no registry', async () => {
    const { body } = await getStatus({ env: {} });
    expect(body.authMode).toBe('none');
    expect(body.clusters).toBeNull();
    expect(typeof body.version).toBe('string');
  });

  it('never carries app config contents', async () => {
    const { body } = await getStatus({ env: {}, appConfig: { apiKey: 'secret' } });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
