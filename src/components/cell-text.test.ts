/**
 * The derived tooltip, and the rail's cluster selector arithmetic.
 *
 * Both are pure, which is the point: `app/fleet-ui` runs vitest with `environment: 'node'`, so
 * neither can be proven by mounting a component. What can be proven here is the part that decides
 * whether a truncated cell is readable at all, and the part that decides what a rail tile says
 * about a cluster nobody has measured yet.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h, Fragment } from 'react';
import { textOf } from './cell-text';
import { abbreviate, filterClusters, nextIndexForKey, showFilter, FILTER_APPEARS_ABOVE } from './cluster-switcher';

describe('textOf', () => {
  it('reads a plain string or number', () => {
    expect(textOf('platform-system')).toBe('platform-system');
    expect(textOf(42)).toBe('42');
  });

  it('reads through the element tree a cell actually renders', () => {
    const cell = h('span', { className: 'mono' }, 'policy-system');
    expect(textOf(cell)).toBe('policy-system');
  });

  it('joins siblings the way a reader sees them, with no leading space from an icon', () => {
    // `<Dot/>{name}` used to produce " my-namespace" — a tooltip that does not match the cell.
    const cell = h(Fragment, null, h('span', { 'aria-hidden': true }), ' ', 'my-namespace');
    expect(textOf(cell)).toBe('my-namespace');
  });

  it('contributes nothing for false, null and undefined', () => {
    // `{cond && <span>…</span>}` must not render the string "false" into a tooltip.
    expect(textOf(false)).toBe('');
    expect(textOf(null)).toBe('');
    expect(textOf(undefined)).toBe('');
    expect(textOf([false, 'ready', null])).toBe('ready');
  });

  it('reads the text a titled element wraps, not the title', () => {
    // Found on the rendered page: the Node column of the pod table renders
    // `<button title="View this node in the Nodes tab">{name}</button>` with a 150px ceiling, and
    // preferring the element's own title gave a clipped node name a tooltip that did not contain
    // the name. Titles inside a cell are instructions, not the cell's text.
    const cell = h('button', { title: 'View this node in the Nodes tab' }, 'ip-10-250-132-244');
    expect(textOf(cell)).toBe('ip-10-250-132-244');
  });

  it('is not derailed by a titled status dot beside the value', () => {
    // `<Dot title="Ready"/>{name}` returned "Ready" and stopped, hiding the one clipped thing.
    const cell = h('span', null, h('span', { title: 'Ready', 'aria-hidden': true }), 'ip-10-250-132-244');
    expect(textOf(cell)).toBe('ip-10-250-132-244');
  });

  it('never invokes a function component', () => {
    let called = false;
    const Custom = () => { called = true; return h('span', null, 'secret'); };
    expect(textOf(h(Custom, null))).toBe('');
    expect(called).toBe(false);
  });

  it('stops at a bounded depth rather than walking an arbitrarily nested tree', () => {
    let node: ReturnType<typeof h> = h('span', null, 'deep');
    for (let i = 0; i < 20; i++) node = h('span', null, node);
    expect(textOf(node)).toBe('');
  });

  it('truncates a pathological value instead of putting a page into a tooltip', () => {
    const out = textOf('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('abbreviate', () => {
  it('takes initials from a two-word name', () => {
    expect(abbreviate({ id: 'x', displayName: 'Platform Sandbox' })).toBe('PS');
  });

  it('splits a generated id on its separators', () => {
    expect(abbreviate({ id: 'platform-sbx' })).toBe('PS');
    expect(abbreviate({ id: 'prod_eu_1' })).toBe('PE');
  });

  it('falls back to the first two characters of a single word', () => {
    expect(abbreviate({ id: 'staging' })).toBe('ST');
  });

  it('never returns an empty tile', () => {
    expect(abbreviate({ id: '' })).toBe('??');
    expect(abbreviate({ id: '', displayName: '   ' })).toBe('??');
  });
});

describe('filterClusters', () => {
  const fleet = [
    { id: 'platform-sbx', displayName: 'Platform Sandbox', env: 'sbx' },
    { id: 'prod-eu', displayName: 'Production EU', env: 'prod' },
    { id: 'prod-us', displayName: 'Production US', env: 'prod' }
  ];

  it('returns everything for an empty or whitespace query', () => {
    expect(filterClusters(fleet, '')).toHaveLength(3);
    expect(filterClusters(fleet, '   ')).toHaveLength(3);
  });

  it('matches the display name, the id and the env', () => {
    expect(filterClusters(fleet, 'sandbox').map(c => c.id)).toEqual(['platform-sbx']);
    expect(filterClusters(fleet, 'prod-us').map(c => c.id)).toEqual(['prod-us']);
    expect(filterClusters(fleet, 'prod').map(c => c.id)).toEqual(['prod-eu', 'prod-us']);
  });

  it('is case-insensitive and returns an empty list rather than a guess', () => {
    expect(filterClusters(fleet, 'PLATFORM').map(c => c.id)).toEqual(['platform-sbx']);
    expect(filterClusters(fleet, 'nothing-like-this')).toEqual([]);
  });
});

describe('showFilter', () => {
  it('stays out of the way of a small fleet and appears for a large one', () => {
    expect(showFilter(1)).toBe(false);
    expect(showFilter(FILTER_APPEARS_ABOVE)).toBe(false);
    expect(showFilter(FILTER_APPEARS_ABOVE + 1)).toBe(true);
  });
});

describe('nextIndexForKey', () => {
  it('moves down from nothing highlighted to the first row', () => {
    expect(nextIndexForKey('ArrowDown', -1, 3)).toBe(0);
  });

  it('clamps rather than wrapping at both ends', () => {
    // Wrapping in a list long enough to scroll moves the highlight off-screen, and the operator
    // cannot tell whether the key did nothing or did too much.
    expect(nextIndexForKey('ArrowDown', 2, 3)).toBe(2);
    expect(nextIndexForKey('ArrowUp', 0, 3)).toBe(0);
  });

  it('jumps to the ends', () => {
    expect(nextIndexForKey('Home', 2, 3)).toBe(0);
    expect(nextIndexForKey('End', 0, 3)).toBe(2);
  });

  it('returns null for a key it does not own, so the handler does not preventDefault', () => {
    expect(nextIndexForKey('a', 0, 3)).toBeNull();
    expect(nextIndexForKey('Tab', 0, 3)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(nextIndexForKey('ArrowDown', -1, 0)).toBeNull();
  });
});
