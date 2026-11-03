/**
 * High-performance, structured client-side action logger.
 *
 * Emits clear, color-coded console logs for:
 *   - [fleet-nav] Route and cluster switches
 *   - [fleet-api] API requests, latencies, and responses
 *   - [fleet-action] User actions (renew, remove, onboard, restart, filters)
 *   - [fleet-error] Handled and unhandled UI failures
 */

type LogLevel = 'info' | 'warn' | 'error' | 'action';

const STYLES: Record<LogLevel, string> = {
  info: 'color: #38bdf8; font-weight: bold;',
  warn: 'color: #f59e0b; font-weight: bold;',
  error: 'color: #ef4444; font-weight: bold;',
  action: 'color: #10b981; font-weight: bold;'
};

export const logger = {
  nav(page: string, params?: Record<string, unknown>) {
    const ts = new Date().toISOString().substring(11, 19);
    console.info(`%c[fleet-nav ${ts}]%c Navigating to: ${page}`, STYLES.info, 'color: inherit', params || '');
  },

  action(actionName: string, detail?: unknown) {
    const ts = new Date().toISOString().substring(11, 19);
    console.info(`%c[fleet-action ${ts}]%c ${actionName}`, STYLES.action, 'color: inherit', detail ?? '');
  },

  api(method: string, url: string, durationMs?: number, status?: number) {
    const ts = new Date().toISOString().substring(11, 19);
    const durStr = durationMs !== undefined ? `(${durationMs}ms)` : '';
    const statusStr = status !== undefined ? `[${status}]` : '';
    console.info(`%c[fleet-api ${ts}]%c ${method} ${url} ${statusStr} ${durStr}`, STYLES.info, 'color: inherit');
  },

  warn(message: string, detail?: unknown) {
    const ts = new Date().toISOString().substring(11, 19);
    console.warn(`%c[fleet-warn ${ts}]%c ${message}`, STYLES.warn, 'color: inherit', detail ?? '');
  },

  error(message: string, error?: unknown) {
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`%c[fleet-error ${ts}]%c ${message}`, STYLES.error, 'color: inherit', error ?? '');
  }
};
