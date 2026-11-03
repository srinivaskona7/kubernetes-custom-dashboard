import { test, vi } from 'vitest';
import assert from 'node:assert';

const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();
vi.mock('../../logger.js', () => ({ getLogger: () => ({ info, warn, error }) }));

import _log from '../log.js';

test('the console-shaped logger forwards to Pino at the matching level', () => {
  _log.log('[renew] a', 1);
  _log.warn('[renew] b');
  _log.error('[renew] c', new Error('boom'));
  assert.strictEqual(info.mock.calls[0][0], '[renew] a 1');
  assert.strictEqual(warn.mock.calls[0][0], '[renew] b');
  assert.match(error.mock.calls[0][0], /^\[renew\] c Error: boom/);
});
