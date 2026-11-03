/**
 * The three figures above the Successful requests table. Rendered to static markup, so it runs in
 * vitest's `node` environment with no DOM: the assertions read the text the browser would be sent.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Trace } from '../../api';
import type { MetricStatus } from '../../components/unavailable';
import { SuccessfulRequests } from './SuccessfulRequests';

// React warns that useLayoutEffect does nothing on the server (the table's Popover uses one). The
// markup is what is under test, so that one warning is dropped and any other console.error prints.
beforeAll(() => {
  const print = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) print(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const read: MetricStatus = { state: 'ok', what: 'successful requests', why: '', blind: 0, total: 1, truncated: false, truncatedWhy: '' };
const unread: MetricStatus = { ...read, state: 'unavailable', why: 'the access log could not be read' };

const request = (i: number): Trace =>
  ({
    traceId: `t${i}`,
    method: 'GET',
    path: '/health',
    authority: 'app.example.com',
    finalStatus: 200,
    totalDurationMs: i + 1,
    hopCount: 2,
    startTime: '2026-09-25T10:00:00.000Z',
    hops: []
  }) as unknown as Trace;

const render = (count: number, status: MetricStatus, kept: string | null = null) =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <SuccessfulRequests
        rows={Array.from({ length: count }, (_, i) => request(i))}
        status={status}
        kept={kept}
        noEvidence={status.state === 'unavailable'}
        showPolls={false}
        onShowPolls={() => {}}
        onOpen={() => {}}
      />
    </StaticRouter>
  );

/** What a tile prints under its caption, tags stripped. */
const tile = (html: string, label: string): string | null => {
  const inner = html.match(new RegExp(`<p class="text-\\[11px\\] text-muted">${label}</p><p class="[^"]*">(.*?)</p>`))?.[1];
  return inner === undefined ? null : inner.replace(/<[^>]*>/g, '');
};

describe('Successful requests figures', () => {
  it('prints a dash with its reason for every figure when the window was not read, never a 0', () => {
    const html = render(0, unread);
    for (const label of ['Successful', 'p95 duration', 'Observed hops']) {
      const text = tile(html, label);
      expect(text, label).not.toBeNull();
      expect(text, label).toContain('—');
      expect(text, label).not.toMatch(/(^|\D)0(\D|$)/);
    }
    expect(html).toContain(unread.why);
    // The empty table says it was not read, not that the window held no request.
    expect(html).toContain('Successful requests not read');
    expect(html).not.toContain('No successful requests');
  });

  it('counts the rows and withholds the p95 below the server floor of 20 durations', () => {
    const html = render(19, read);
    expect(tile(html, 'Successful')).toBe('19');
    expect(tile(html, 'p95 duration')).toBe('n=19');
    expect(tile(html, 'Observed hops')).toBe('38');
  });

  it('prints the nearest-rank p95 once there are 20 durations', () => {
    // 25 durations of 1..25 ms: the rank rounds up to the 24th.
    expect(tile(render(25, read), 'p95 duration')).toBe('24ms');
  });

  it('a window that was read and held no successful request is a true zero, not a dash', () => {
    const html = render(0, read);
    expect(tile(html, 'Successful')).toBe('0');
    expect(tile(html, 'p95 duration')).toBe('—');
    expect(html).toContain('No successful requests in this window');
    expect(html).not.toContain('Successful requests not read');
    // Nothing capped it, so hidden liveness polls are the one thing left to try.
    expect(html).toContain('Successful liveness polls are hidden from this read.');
    expect(html).toContain('>Include liveness polls<');
  });

  it('names the kept count under the figures when the collector capped the window', () => {
    const html = render(5, read, '200 kept of 1,509: app first');
    expect(html).toContain('Figures cover the kept journeys only (200 kept of 1,509: app first).');
  });

  it('a capped window whose kept journeys hold no success says so, not that the window held none', () => {
    const html = render(0, read, '200 kept of 1,509: app first');
    expect(tile(html, 'Successful')).toBe('0');
    expect(html).toContain('Figures cover the kept journeys only (200 kept of 1,509: app first).');
    expect(html).toContain('No successful requests among the kept journeys');
    expect(html).toContain('The cap left the rest of the window unexamined (200 kept of 1,509: app first).');
    // The window-wide negative, and the liveness-poll cause with its button, belong to an uncapped window.
    expect(html).not.toContain('No successful requests in this window');
    expect(html).not.toContain('Successful liveness polls are hidden');
    expect(html).not.toContain('>Include liveness polls<');
  });

  it('prints no cap caption on an uncapped window, nor over figures that were not read', () => {
    expect(render(5, read)).not.toContain('kept journeys');
    expect(render(0, unread, '200 kept of 1,509: app first')).not.toContain('kept journeys');
  });
});
