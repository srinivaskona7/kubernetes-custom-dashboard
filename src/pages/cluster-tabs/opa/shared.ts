/**
 * Shared vocabulary for the five OPA screens: tones, ordering, filter state, and the policy
 * drawer every one of them opens.
 *
 * The reason this file exists rather than each tab defining its own: "risky first" and "what
 * warning looks like" are answers the five screens must give identically. A deny policy with
 * violations that sorts third on Policies and seventh on Coverage is two different claims about
 * the same cluster.
 *
 * ## Read-only, and where that is enforced
 *
 * There is no control in this file or its neighbours that issues a write. The drawer's action row
 * is navigation and inspection only — View Violations, View Affected Resources, View YAML, Open
 * Full Page — and the YAML pane is a `<pre>`, not an editor. The repo's own guard test greps the
 * source for mutation verbs in UI labels; adding an Apply button here fails the suite.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  OpaCategory,
  OpaEnforcementAction,
  OpaPolicy,
  OpaPolicyStatus,
  OpaViolation
} from '../../../api';
import type { Tone } from '../../../components/ui';
import { RESOURCE_KINDS } from '../../../resources/registry';
import type { ResourceKind } from '../../../resources/types';

export const ACTION_TONE: Record<OpaEnforcementAction, Tone> = {
  deny: 'ok',
  warn: 'warn',
  dryrun: 'accent',
  unknown: 'unknown'
};

export const STATUS_TONE: Record<OpaPolicyStatus, Tone> = {
  active: 'ok',
  warning: 'warn',
  inactive: 'bad',
  unknown: 'unknown'
};

/**
 * Structurally broken, as opposed to merely ineffective.
 *
 * These three reason codes mean the policy cannot evaluate at all: the template the API server
 * rejected, the constraint list nobody could read, the constraint Gatekeeper has not reconciled.
 * Every other reason describes a policy that runs and chooses not to block. Exported because the
 * posture bar and the risk sort must agree on the word "invalid" — two definitions would put a row
 * in the red band and at the bottom of the table at the same time.
 */
export function isBroken(p: OpaPolicy): boolean {
  return p.ineffectiveReasons.some(
    r => r.code === 'TEMPLATE_ERROR' || r.code === 'CONSTRAINTS_UNREADABLE' || r.code === 'NOT_RECONCILED'
  );
}

/**
 * The exact risk order the spec asks for, worst first.
 *
 * The two rungs at the top are the ones that matter and the ones a naive sort loses: a policy
 * that is broken, and a policy that is declared but enforces nothing, both look perfectly healthy
 * in `kubectl get constraints` and both sort to the bottom of any list ordered by violation count
 * — because they have none, which is precisely the symptom.
 */
export function riskRank(p: OpaPolicy): number {
  if (isBroken(p)) return 0;
  if (p.status === 'inactive') return 1;
  const violating = (p.violationCount ?? 0) > 0;
  if (violating && p.enforcementAction === 'deny') return 2;
  if (violating && p.enforcementAction === 'warn') return 3;
  if (violating && p.enforcementAction === 'dryrun') return 4;
  if (p.ineffectiveReasons.length > 0) return 5;
  return 6;
}

export function byRisk(a: OpaPolicy, b: OpaPolicy): number {
  return riskRank(a) - riskRank(b)
    || (b.violationCount ?? 0) - (a.violationCount ?? 0)
    || a.displayName.localeCompare(b.displayName);
}

/**
 * The plain-language summary of a policy's namespace reach.
 *
 * "25 of 29 namespaces" rather than a selector dump, because the selector is the input and the
 * count is the answer. `unknown` when the namespace list could not be read — never "0 of 0",
 * which would read as a policy that reaches nothing.
 */
export function scopeLine(p: OpaPolicy): string {
  const s = p.namespaceScope;
  if (!s.evaluable) return 'namespace reach unknown — the namespace list could not be read';
  if (s.scope === 'cluster-wide') return `every namespace (${s.totalNamespaces})`;
  if (s.matchedNamespaceCount === 0) return 'no namespace on this cluster';
  return `${s.matchedNamespaceCount} of ${s.totalNamespaces} namespaces`;
}

/** Target kinds as one readable clause, wildcards said in words. */
export function kindLine(p: OpaPolicy): string {
  const kinds = [...new Set(p.targetKinds.flatMap(t => t.kinds))];
  if (kinds.length === 0) return 'no kinds configured';
  if (kinds.includes('*')) return 'every resource kind';
  if (kinds.length <= 3) return kinds.join(', ');
  return `${kinds.slice(0, 3).join(', ')} +${kinds.length - 3}`;
}

/** How stale the audit is, in words an operator reads faster than a timestamp. */export function auditLine(p: OpaPolicy): string {
  const a = p.audit;
  if (a.state === 'never') return 'audit has never run';
  if (a.ageSeconds === null) return 'audit time unreadable';
  if (a.ageSeconds < 120) return `${a.ageSeconds}s ago`;
  if (a.ageSeconds < 7200) return `${Math.round(a.ageSeconds / 60)}m ago`;
  if (a.ageSeconds < 172800) return `${Math.round(a.ageSeconds / 3600)}h ago`;
  return `${Math.round(a.ageSeconds / 86400)}d ago`;
}

/**
 * The Kind as a `ResourceRef` Kind, or null when this console has no drawer for it.
 *
 * Gatekeeper violations name whatever the policy targets — `Role`, `RoleBinding`, `NetworkPolicy`
 * — and only a subset of Kinds has a registered resolver. Rendering a link for the rest would open
 * a drawer that can only say "not in view", so those stay plain text. Checked against the
 * registry's own list rather than a copy of it, so a Kind gaining a drawer lights up here with no
 * further change.
 */
export function linkableKind(kind: string): ResourceKind | null {
  return (RESOURCE_KINDS as string[]).includes(kind) ? (kind as ResourceKind) : null;
}

// -----------------------------------------------------------------------------------------
// Filter state, in the URL
// -----------------------------------------------------------------------------------------
/**
 * Every OPA filter, read from and written to the query string.
 *
 * In the URL rather than component state for two reasons that both bite otherwise: a finding's
 * drilldown has to be able to *set* a filter from another screen (which a `useState` in a child
 * cannot be handed), and an operator sharing "the three dry-run policies" needs the link to open
 * on those three.
 *
 * Keys are prefixed `o` so they cannot collide with the cluster page's own `?tab=`/`?section=`
 * or with a future Violations filter on another screen.
 */
export interface OpaFilters {
  q: string;
  action: OpaEnforcementAction | 'all';
  /**
   * `broken` is not a Gatekeeper status — it is `isBroken()`, the policies that cannot evaluate at
   * all. It earns a filter value of its own because it is the state an operator most needs to reach
   * and the one no native field names: a broken policy's `status` is whatever its last reconcile
   * left behind.
   */
  status: OpaPolicyStatus | 'all' | 'broken';
  kind: string | 'all';
  category: OpaCategory | 'all';
  namespace: string | 'all';
  /** 'violating' — has at least one audit violation. 'clean' — has none. */
  violations: 'all' | 'violating' | 'clean';
  /** Violations tab only: which source the row came from. */
  source: 'all' | 'gatekeeper-audit' | 'admission-metric' | 'decision-log';
  /** Violations tab only: whether the referenced object is still resolvable. */
  resolved: 'all' | 'resolvable' | 'deleted';
  /** One policy id, set when a finding drills into a single policy's rows. */
  policy: string | 'all';
  /** Policies tab only: the template's relation to gatekeeper-library (`behind` is a library row on an older version). */
  origin: 'all' | 'library' | 'modified' | 'custom' | 'behind';
}

const DEFAULTS: OpaFilters = {
  q: '', action: 'all', status: 'all', kind: 'all', category: 'all',
  namespace: 'all', violations: 'all', source: 'all', resolved: 'all', policy: 'all', origin: 'all'
};

const PARAM: Record<keyof OpaFilters, string> = {
  q: 'oq', action: 'oaction', status: 'ostatus', kind: 'okind', category: 'ocategory',
  namespace: 'ons', violations: 'oviol', source: 'osource', resolved: 'oresolved', policy: 'opolicy', origin: 'oorigin'
};

export function useOpaFilters(): {
  filters: OpaFilters;
  set: (patch: Partial<OpaFilters>) => void;
  reset: () => void;
  activeCount: number;
} {
  const [params, setParams] = useSearchParams();

  const filters = useMemo(() => {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(PARAM) as (keyof OpaFilters)[]) {
      const raw = params.get(PARAM[key]);
      if (raw) (out as Record<string, string>)[key] = raw;
    }
    return out;
  }, [params]);

  const set = useCallback(
    (patch: Partial<OpaFilters>) => {
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch) as [keyof OpaFilters, string][]) {
            // A filter back at its default is absent from the URL, not present-and-empty. Keeps a
            // shared link short and makes `activeCount` below a simple key count.
            if (!value || value === DEFAULTS[key]) next.delete(PARAM[key]);
            else next.set(PARAM[key], value);
          }
          next.delete('res');
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const reset = useCallback(() => {
    setParams(
      prev => {
        const next = new URLSearchParams(prev);
        for (const p of Object.values(PARAM)) next.delete(p);
        return next;
      },
      { replace: true }
    );
  }, [setParams]);

  const activeCount = (Object.keys(PARAM) as (keyof OpaFilters)[])
    .filter(k => filters[k] !== DEFAULTS[k]).length;

  return { filters, set, reset, activeCount };
}

/** Apply the policy-relevant filters. Search matches identity and purpose, never invented text. */
export function filterPolicies(policies: OpaPolicy[], f: OpaFilters): OpaPolicy[] {
  const q = f.q.trim().toLowerCase();
  return policies.filter(p => {
    if (f.action !== 'all' && p.enforcementAction !== f.action) return false;
    if (f.status === 'broken' && !isBroken(p)) return false;
    if (f.status !== 'all' && f.status !== 'broken' && p.status !== f.status) return false;
    if (f.category !== 'all' && p.category !== f.category) return false;
    if (f.policy !== 'all' && p.id !== f.policy) return false;
    if (f.kind !== 'all' && !p.targetKinds.some(t => t.kinds.includes(f.kind))) return false;
    if (f.namespace !== 'all') {
      const reach = p.namespaceScope;
      // A policy whose reach could not be evaluated is kept rather than dropped: excluding it
      // would let a namespace filter quietly hide policies that may well apply there.
      if (reach.evaluable && !(reach.matchedNamespaces ?? []).includes(f.namespace)) return false;
    }
    if (f.origin === 'behind' && p.library.behind !== true) return false;
    if (f.origin !== 'all' && f.origin !== 'behind' && p.library.state !== f.origin) return false;
    if (f.violations === 'violating' && !((p.violationCount ?? 0) > 0)) return false;
    if (f.violations === 'clean' && (p.violationCount ?? 0) > 0) return false;
    if (q) {
      const haystack = [p.displayName, p.templateName, p.constraintName ?? '', p.constraintKind ?? '', p.purpose.text]
        .join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export function filterViolations(violations: OpaViolation[], f: OpaFilters, resolvable: (v: OpaViolation) => boolean): OpaViolation[] {
  const q = f.q.trim().toLowerCase();
  return violations.filter(v => {
    if (f.policy !== 'all' && v.policyId !== f.policy) return false;
    if (f.action !== 'all' && v.enforcementAction !== f.action) return false;
    if (f.category !== 'all' && v.category !== f.category) return false;
    if (f.kind !== 'all' && v.kind !== f.kind) return false;
    if (f.namespace !== 'all' && (v.namespace ?? '-') !== f.namespace) return false;
    if (f.source !== 'all' && v.source !== f.source) return false;
    if (f.resolved === 'resolvable' && !resolvable(v)) return false;
    if (f.resolved === 'deleted' && resolvable(v)) return false;
    if (q && !`${v.name} ${v.namespace ?? ''} ${v.kind} ${v.message}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
