/**
 * How the meter draws each verdict. Rendered to static markup, so it runs in vitest's `node`
 * environment with no DOM: the assertions read the classes and titles the browser would get.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MeterLegend, ResourceMeter } from './ResourceMeter';
import type { Figures } from './namespace-usage';

const meter = (figures: Figures, metric: 'cpu' | 'memory' = 'cpu') =>
  renderToStaticMarkup(<ResourceMeter compact label="CPU" metric={metric} figures={figures} />);

/** The class attribute of the element whose title starts with `prefix`. */
const classOfTitled = (html: string, prefix: string) =>
  html.match(new RegExp(`title="${prefix}[^"]*"[^>]*class="([^"]*)"`))?.[1] ?? null;

describe('ResourceMeter', () => {
  it('draws no fill and no ticks when neither a request nor a limit was declared', () => {
    const html = meter({ used: 0.001, request: null, limit: null });
    expect(html).not.toContain('bg-ok');
    expect(html).not.toContain('title="Requested');
    expect(html).not.toContain('title="Limit');
    expect(html).toContain('No request configured');
    expect(html).toContain('>1m / none / none</p>');
    // `border-line` measured 1.4:1 against the row; muted at 80% clears 3:1 in both themes.
    expect(html).toContain('border border-dashed border-muted/80');
    expect(html).not.toContain('border-line');
    // The named form is not dropped, only moved: the bar's tooltip and its accessible value.
    expect(html).toContain('title="CPU: used 1m · req none · lim none"');
  });

  it('fills neutral, not green, against a limit when no request was declared', () => {
    const html = meter({ used: 0.1, request: null, limit: 1 });
    expect(html).not.toContain('bg-ok');
    expect(html).toContain('bg-unknown');
    expect(html).not.toContain('title="Requested');
    expect(classOfTitled(html, 'Limit')).not.toBeNull();
  });

  it('keeps the green fill for usage inside a declared request', () => {
    expect(meter({ used: 0.1, request: 0.2, limit: 1 })).toContain('bg-ok');
  });

  it('sets the above-request badge inline beside the percentage, amber and never red', () => {
    const html = meter({ used: 0.3, request: 0.2, limit: 1 });
    const line = (html.match(/<span class="flex[^"]*">(.*?)<\/span><\/div>/)?.[1] ?? '').replace(/<[^>]+>/g, '');
    expect(line).toContain('150% of request');
    expect(line).toContain('Above request');
    expect(line.indexOf('150% of request')).toBeLessThan(line.indexOf('Above request'));
    // One amber carrier: the badge. The percentage beside it stays in the body colour.
    expect(html.match(/text-warn/g)).toHaveLength(1);
    expect(html).toMatch(/text-warn[^"]*">Above request/);
    expect(html).toMatch(/class="tabular-nums text-\[12px\] text-text"><span class="font-medium">150%/);
    expect(html).not.toContain('text-bad');
  });

  it('carries at-limit in the solid red badge and a solid limit tick, not the percentage', () => {
    const html = meter({ used: 1, request: 0.2, limit: 1 });
    // The solid red badge and the solid tick carry it; the percentage stays in the body colour.
    expect(html).toMatch(/class="tabular-nums text-\[12px\] text-text"><span class="font-medium">500%/);
    expect(html).toMatch(/bg-bad text-white[^"]*">At limit/);
    expect(classOfTitled(html, 'Limit')).toMatch(/(^| )bg-bad( |$)/);
  });

  it('draws a 7px track, with the limit tick 2px proud of it on both sides', () => {
    const html = meter({ used: 0.1, request: 0.2, limit: 1 });
    // On the card surface `bg-raised` measured 1.14:1 in both themes and the empty part vanished.
    expect(html).toContain('mt-[5px] h-[7px] w-full rounded-[3.5px] bg-line-strong/70');
    expect(html).not.toContain('bg-raised');
    // 7px track + 2px above + 2px below.
    expect(classOfTitled(html, 'Limit')).toMatch(/-top-\[2px\] h-\[11px\]/);
  });

  it('sizes the compact meter to its cell and keeps the positioned wrapper for the sr-only label', () => {
    const html = meter({ used: 0.1, request: 0.2, limit: 1 });
    expect(html).not.toContain('w-[230px]');
    expect(html).toMatch(/^<div class="relative w-full min-w-\[180px\] text-left"/);
    expect(html).not.toContain('max-w-');
    expect(html).toContain('class="sr-only">CPU</span>');
  });

  // The table cell gives the meter about 182px, and a named caption wrapped to two lines there.
  it('prints the compact caption as one used / request / limit triple', () => {
    expect(meter({ used: 0.011, request: 0.19, limit: 1.5 })).toContain('>11m / 190m / 1.5</p>');
    const gib = 1024 ** 3;
    const partial = meter({ used: 0.37 * gib, request: 0.31 * gib, limit: 1.3 * gib, limitPartial: true }, 'memory');
    expect(partial).toMatch(/>\S+ MiB \/ \S+ MiB \/ ≥1\.3 GiB<\/p>/);
    expect(partial).toContain('aria-valuetext="119% of request; used ');
  });

  it('keeps the badge on the percentage line, and wraps only as a fallback', () => {
    const html = meter({ used: 0.3, request: 0.2, limit: 1 }, 'memory');
    expect(html).toMatch(/<span class="flex[^"]*flex-wrap[^"]*">[^]*Above request/);
    expect(html).toMatch(/<p class="[^"]*whitespace-nowrap[^"]*">/);
  });

  it('keeps the meter role and its accessible name', () => {
    const html = meter({ used: 0.1, request: 0.2, limit: 1 });
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="CPU usage against request"');
  });
});

describe('MeterLegend', () => {
  it('names all three keys at 11px, in the order the caption prints them', () => {
    const html = renderToStaticMarkup(<MeterLegend />);
    // The key is drawn at the bar's scale: an 18x7 track, the limit tick 11px tall and 2px proud.
    expect(html.match(/h-\[7px\] w-\[18px\] rounded-\[3\.5px\]/g)).toHaveLength(3);
    expect(html).toMatch(/-top-\[2px\] left-\[14px\] h-\[11px\] w-\[2px\]/);
    expect(html).toContain('text-[11px]');
    expect(html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).toBe('used / request / limit');
    for (const key of ['used', 'request', 'limit']) expect(html).toContain(key);
    // No hairline in the key: each swatch is a short track with the bar's own mark on it.
    expect(html).not.toMatch(/inline-block h-\[6px\] w-px/);
    expect(html.match(/bg-line-strong\/70/g)).toHaveLength(3);
  });
});
