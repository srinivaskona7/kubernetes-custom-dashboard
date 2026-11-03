import { describe, expect, it } from 'vitest';
import { TAB_SECTIONS, tabSubtitle } from './tabs';

describe('tabSubtitle', () => {
  it('names the Namespaces section, and the bare tab URL that opens on it', () => {
    expect(tabSubtitle('workloads', 'namespaces')).toMatch(/^Browse namespaces/);
    expect(tabSubtitle('workloads', null)).toMatch(/^Browse namespaces/);
    expect(tabSubtitle('workloads', 'no-such-section')).toMatch(/^Browse namespaces/);
  });

  it('leaves every other section of the tab on its TAB_ABOUT line', () => {
    const others = TAB_SECTIONS.workloads.map(s => s.id).filter(id => id !== 'namespaces');
    expect(others.length).toBeGreaterThan(0);
    for (const id of others) expect(tabSubtitle('workloads', id)).toBeUndefined();
  });

  it('leaves other tabs unchanged', () => {
    expect(tabSubtitle('overview', null)).toBeUndefined();
    expect(tabSubtitle('nodes', 'zones')).toBeUndefined();
  });
});
