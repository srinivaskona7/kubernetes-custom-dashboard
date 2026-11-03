import pino from 'pino';

let logger;

export function createLogger(config) {
  logger = pino({
    level: config.logLevel || 'info',
    transport: {
      target: 'pino-pretty',
    },
  });
  return logger;
}

export function getLogger() {
  if (!logger) {
    logger = pino({
      level: 'info',
      transport: { target: 'pino-pretty' },
    });
  }
  return logger;
}
