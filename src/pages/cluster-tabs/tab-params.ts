/**
 * The URL a tab switch lands on: every parameter only the tab being left reads is dropped.
 *
 * One rule for both switches (ClusterDetail's `setTab` and the rail's `select`). They used to be
 * two hand-written copies, and they drifted: the rail kept `?top=`, and neither dropped `?nsview=`,
 * so leaving a Namespaces ranking and coming back reopened the ranking instead of the table.
 */
import { clearLogParams } from './log-link';
import type { Tab } from './tabs';

/** Parameters read by one tab only, keyed by that tab. */
const OWNED: Partial<Record<Tab, readonly string[]>> = {
  nodes: ['node'],
  workloads: ['workload', 'top', 'nsview', 'ntop']
};
/** Read by more than one tab but meant for the open one only: the Proxies read panel (`useProxiesPanel`). */
const PER_VISIT = ['proxies'] as const;

export function tabSwitchParams(params: URLSearchParams, next: Tab, section?: string): URLSearchParams {
  const p = next === 'logs' ? new URLSearchParams(params) : clearLogParams(params);
  p.set('tab', next);
  // `?section=` ids repeat across tabs, so carrying one over would open the next tab mid-way down.
  if (section) p.set('section', section);
  else p.delete('section');
  for (const k of PER_VISIT) p.delete(k);
  for (const [tab, keys] of Object.entries(OWNED) as [Tab, readonly string[]][]) {
    if (tab !== next) for (const k of keys) p.delete(k);
  }
  return p;
}
