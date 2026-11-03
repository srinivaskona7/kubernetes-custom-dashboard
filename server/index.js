import 'dotenv/config';
import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadWhisper } from './config.js';
import { loadDb } from './db.js';
import { createLogger } from './logger.js';
import { shieldAuth } from './middleware/shieldAuth.js';
import { mountFleet, assertAuthAllowed } from './fleet/mount.js';
import statusRoutes from './routes/status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger({ logLevel: process.env.LOG_LEVEL || 'info' });

const db = await loadDb();

const app = express();
app.locals.whisper = await loadWhisper();
app.locals.db = db;

const PORT = process.env.PORT || 3001;

app.use(shieldAuth);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// A misconfigured NODE_ENV must not be the only thing standing between the fleet and an
// unauthenticated API.
try {
  assertAuthAllowed();
} catch (err) {
  log.fatal(`[fleet] FATAL: ${err.message}`);
  process.exit(1);
}

// The fleet parses its own bodies (it allows a larger kubeconfig upload than the default
// limit), so it is mounted ahead of any app-wide body parser.
const apiRoutes = express.Router();
mountFleet(apiRoutes, { db });
apiRoutes.use('/api/status', statusRoutes({ whisper: app.locals.whisper }));

app.use('/', apiRoutes);
const basePath = process.env.BASE_PATH;
if (basePath && basePath !== '/') {
  app.use(basePath, apiRoutes);
}

if (process.env.NODE_ENV === 'production') {
  const distPath = resolve(__dirname, '..', 'dist');
  const staticBase = process.env.BASE_PATH || '/';

  app.use(staticBase, express.static(distPath));
  app.get(`${staticBase}*`, (req, res) => {
    res.sendFile(resolve(distPath, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Btp Kyma Fleet Dashboard server started');
});

// Registering a signal listener (the fleet renewer does) removes Node's default exit on
// SIGTERM, so the process has to leave deliberately or the pod waits out its grace period.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
