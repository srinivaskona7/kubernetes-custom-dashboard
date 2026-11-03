/**
 * The console-shaped logger the renewal clock takes by injection (`{ log, warn, error }`),
 * backed by the template's Pino singleton. Tests pass their own recorder instead.
 */
import { getLogger } from '../logger.js';

const line = args => args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');

export default {
  log: (...args) => getLogger().info(line(args)),
  warn: (...args) => getLogger().warn(line(args)),
  error: (...args) => getLogger().error(line(args))
};
