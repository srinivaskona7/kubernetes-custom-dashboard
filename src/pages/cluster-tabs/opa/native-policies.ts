/**
 * Words and counts for the Native policies tab — built-in ValidatingAdmissionPolicies joined to
 * their bindings on the server (`nativePolicyEntries` in srv/fleet/collectors/policy.js).
 *
 * Pure, so the vocabulary is tested without a DOM. The one rule it keeps: a policy with no binding
 * is admitted by the API server and enforces nothing, and says so in words — `kubectl get vap`
 * lists it looking exactly like one that denies.
 */
import type { NativePolicy, NativePolicyBinding } from '../../../api';
import type { Tone } from '../../../components/ui';

export const NATIVE_STATUS: Record<NativePolicy['effectiveStatus'], { label: string; tone: Tone; hint: string }> = {
  enforcing: { label: 'deny', tone: 'ok', hint: 'At least one binding denies a failing request' },
  'warn-only': { label: 'warn', tone: 'warn', hint: 'Bindings return a warning; the request is admitted' },
  'audit-only': { label: 'audit', tone: 'unknown', hint: 'Bindings only annotate the audit log; the request is admitted' },
  unbound: { label: 'unbound', tone: 'warn', hint: 'No binding selects this policy, so it evaluates nothing' },
  'no-action': { label: 'no action', tone: 'warn', hint: 'Bound, but no binding names a validation action' },
  unknown: { label: 'unknown', tone: 'unknown', hint: 'The binding list was not read, so what this policy enforces is not known' }
};

/** Worst-first for an operator: what enforces nothing, then what only warns, then what denies. */
const STATUS_RANK: Record<NativePolicy['effectiveStatus'], number> = {
  unknown: -1,
  unbound: 0,
  'no-action': 1,
  'audit-only': 2,
  'warn-only': 3,
  enforcing: 4
};

export function byNativeRisk(a: NativePolicy, b: NativePolicy): number {
  return STATUS_RANK[a.effectiveStatus] - STATUS_RANK[b.effectiveStatus] || a.name.localeCompare(b.name);
}

export function countByStatus(policies: NativePolicy[]): Record<NativePolicy['effectiveStatus'], number> {
  const out = { enforcing: 0, 'warn-only': 0, 'audit-only': 0, unbound: 0, 'no-action': 0, unknown: 0 };
  for (const p of policies) out[p.effectiveStatus] += 1;
  return out;
}

/** "CREATE, UPDATE · pods, deployments +2" — the operations and the resources, wildcards in words. */
export function targetLine(p: NativePolicy): string {
  const t = targetParts(p);
  return `${t.operations} · ${t.resources}`;
}

/** The same two halves apart, so a narrow cell can put each on its own line. */
export function targetParts(p: NativePolicy): { operations: string; resources: string } {
  const operations = p.operations.length === 0 ? 'no operation' : p.operations.includes('*') ? 'every operation' : p.operations.join(', ');
  if (p.wildcard) return { operations, resources: 'every resource' };
  const all = [...new Set(p.rules.map(r => r.resource))];
  if (all.length === 0) return { operations, resources: 'no resource' };
  return { operations, resources: `${all.slice(0, 3).join(', ')}${all.length > 3 ? ` +${all.length - 3}` : ''}` };
}

/** One binding's namespace reach. `unknown` when the namespace list was not read — never "0 of 0". */
export function bindingScopeLine(b: NativePolicyBinding): string {
  const s = b.namespaceScope;
  if (!s.evaluable) return 'reach unknown';
  if (s.scope === 'cluster-wide') return `every namespace (${s.totalNamespaces})`;
  if (s.matchedNamespaceCount === 0) return 'no namespace on this cluster';
  return `${s.matchedNamespaceCount} of ${s.totalNamespaces} namespaces`;
}

/** The policy's binding reach in one line: the widest binding, and how many others there are. */
export function bindingsLine(p: NativePolicy): string {
  if (p.effectiveStatus === 'unknown') return 'bindings not read';
  if (p.bindings.length === 0) return 'no binding';
  const widest = [...p.bindings].sort(
    (a, b) => (b.namespaceScope.matchedNamespaceCount ?? -1) - (a.namespaceScope.matchedNamespaceCount ?? -1)
  )[0]!;
  const more = p.bindings.length - 1;
  return `${bindingScopeLine(widest)}${more > 0 ? ` · +${more} binding${more === 1 ? '' : 's'}` : ''}`;
}
