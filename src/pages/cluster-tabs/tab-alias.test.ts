/** Retired tab ids still land somewhere deliberate. */
import { describe, expect, it } from 'vitest';
import { SECTION_ALIASES, TAB_ALIASES, TAB_IDS, TAB_SECTIONS, resolveTabAlias, sectionAlias } from './tabs';

describe('resolveTabAlias', () => {
  it('sends Top Utilization to Namespaces & Workloads → Top Consumers', () => {
    const out = resolveTabAlias(new URLSearchParams('tab=utilization'));
    expect(out?.toString()).toBe('tab=workloads&section=top');
  });

  it('keeps the namespace selection and drops everything the old tab owned', () => {
    const raw = 'tab=utilization&section=pressure&umetric=memory&urank=usage&utop=20&uns=x&uq=a&uhidesys=1&uexpand=k&ns=foo&res=Pod/foo/p';
    const out = resolveTabAlias(new URLSearchParams(raw));
    expect(Object.fromEntries(out!)).toEqual({ tab: 'workloads', section: 'top', ns: 'foo' });
  });

  it('never lands an old Top Utilization section on the workloads section of the same name', () => {
    // `pods` and `namespaces` are ids on both tabs; they meant a different screen on the old one.
    for (const section of ['pods', 'namespaces', 'overview']) {
      expect(resolveTabAlias(new URLSearchParams(`tab=utilization&section=${section}`))?.get('section')).toBe('top');
    }
  });

  it('keeps Autoscaling links on the section the target owns, with their other params', () => {
    expect(resolveTabAlias(new URLSearchParams('tab=autoscaling'))?.toString()).toBe('tab=workloads&section=hpas');
    const out = resolveTabAlias(new URLSearchParams('tab=autoscaling&section=cronjobs&ns=foo'));
    expect(Object.fromEntries(out!)).toEqual({ tab: 'workloads', section: 'cronjobs', ns: 'foo' });
    expect(resolveTabAlias(new URLSearchParams('tab=autoscaling&section=nope'))?.get('section')).toBe('hpas');
  });

  it('leaves a live tab alone', () => {
    expect(resolveTabAlias(new URLSearchParams('tab=workloads&section=pods'))).toBeNull();
    expect(resolveTabAlias(new URLSearchParams(''))).toBeNull();
  });
});

describe('TAB_ALIASES', () => {
  it('only aliases a retired id, to a tab and section that exist', () => {
    for (const [from, to] of Object.entries(TAB_ALIASES)) {
      expect(TAB_IDS.has(from), `${from} is still a live tab`).toBe(false);
      expect(TAB_IDS.has(to!.tab)).toBe(true);
      const list = (TAB_SECTIONS as Record<string, readonly { id: string }[]>)[to!.tab] ?? [];
      if (to!.preserveSection) continue;
      expect(list.map(s => s.id)).toContain(to!.section);
    }
  });
});

describe('Ingress & Traffic section aliases', () => {
  it('has exactly the five sub-tabs, in order', () => {
    expect(TAB_SECTIONS.traffic.map(s => s.id)).toEqual(['ingress', 'failures', 'hosts', 'clients', 'gateway']);
  });

  it('keeps every sub-tab description to one short line', () => {
    for (const s of [...TAB_SECTIONS.traffic, ...TAB_SECTIONS.traces]) expect(s.description.length, s.id).toBeLessThanOrEqual(90);
  });

  it('redirects each retired section id, keeping the other params', () => {
    const cases: [string, string][] = [['listeners', 'hosts'], ['codes', 'failures'], ['path', 'gateway'], ['window', 'ingress']];
    for (const [from, to] of cases) {
      const out = resolveTabAlias(new URLSearchParams(`tab=traffic&section=${from}&ns=x&res=Pod/a/b`));
      expect(out?.get('tab'), from).toBe('network');
      expect(out?.get('networkView'), from).toBe('edge');
      expect(out?.get('section'), from).toBe(to);
      expect(out?.get('ns')).toBe('x');
      expect(out?.get('res')).toBe('Pod/a/b');
    }
  });

  it('opens the proxies panel for the retired Proxies read sub-tab', () => {
    expect(resolveTabAlias(new URLSearchParams('tab=traffic&section=window'))?.get('proxies')).toBe('1');
  });

  it('redirects a former live section to Network Operations', () => {
    const out = resolveTabAlias(new URLSearchParams('tab=traffic&section=hosts'));
    expect(out?.get('tab')).toBe('network');
    expect(out?.get('networkView')).toBe('edge');
    expect(out?.get('section')).toBe('hosts');
    expect(sectionAlias('traffic', 'hosts')).toBeNull();
    expect(sectionAlias('traffic', null)).toBeNull();
    // An object-prototype key is not an alias: `map[section]` alone would hand back a function.
    expect(sectionAlias('traffic', 'constructor')).toBeNull();
    expect(sectionAlias('constructor', 'hosts')).toBeNull();
  });

  it('only aliases retired ids, onto sections that exist', () => {
    for (const [tab, map] of Object.entries(SECTION_ALIASES)) {
      for (const [from, to] of Object.entries(map!)) {
        const targetTab = to.set?.tab;
        const ids = (TAB_SECTIONS as Record<string, readonly { id: string }[]>)[targetTab ?? tab]!.map(s => s.id);
        if (!targetTab || targetTab === tab) expect(ids).not.toContain(from);
        expect(ids).toContain(to.section);
      }
    }
  });
});
