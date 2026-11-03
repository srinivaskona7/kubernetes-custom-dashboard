/** Leaving a tab drops every parameter only that tab reads; both tab switches share one rule. */
import { describe, expect, it } from 'vitest';
import { tabSwitchParams } from './tab-params';

const from = (q: string) => new URLSearchParams(q);

describe('tabSwitchParams', () => {
  it('drops the Namespaces view and the other workloads-only params when leaving Namespaces & Workloads', () => {
    const out = tabSwitchParams(from('tab=workloads&section=namespaces&nsview=cpu&ntop=30&workload=a/b&top=x'), 'security');
    expect(Object.fromEntries(out)).toEqual({ tab: 'security' });
  });

  it('keeps them when the switch stays on Namespaces & Workloads', () => {
    const out = tabSwitchParams(from('tab=workloads&nsview=memory&workload=a/b'), 'workloads', 'namespaces');
    expect(Object.fromEntries(out)).toEqual({ tab: 'workloads', section: 'namespaces', nsview: 'memory', workload: 'a/b' });
  });

  it('drops a node away from Nodes and every log param away from Logs', () => {
    const out = tabSwitchParams(from('tab=nodes&node=n1&pod=p&ns=x'), 'cost');
    expect(Object.fromEntries(out)).toEqual({ tab: 'cost' });
  });

  it('keeps log params when the switch lands on Logs', () => {
    expect(tabSwitchParams(from('tab=workloads&pod=p&ns=x'), 'logs').get('pod')).toBe('p');
  });

  it('closes the Proxies read panel on a switch, so the next tab does not open with it', () => {
    expect(tabSwitchParams(from('tab=traffic&section=ingress&proxies=1'), 'traces').has('proxies')).toBe(false);
  });

  it('never carries a section across tabs unless one is given', () => {
    expect(tabSwitchParams(from('tab=networking&section=mesh'), 'security').has('section')).toBe(false);
  });
});
