/**
 * Which investigation steps a selected resource offers, as a pure function.
 *
 * The drawer is the one surface reachable from every tab, which makes it the right place to put
 * "and now what" — and the wrong place to work it out inline. The decision is a rule over the
 * resolved row (does this pod have restarts? does it have more than one container?) and rules like
 * that are worth testing without a router, a DOM or a rendered drawer.
 *
 * ## Why the drawer needed this at all
 *
 * `ResourceDetailDrawer` has always accepted an `extraFor` callback and its docstring named the
 * intended use — "an events list, a log shortcut" — but nothing ever passed one. So the Pod drawer
 * was a **dead end**: an operator who reached a pod from the Traffic tab's failing-upstream table,
 * or from a Node's pod list, could read its phase and its restart count and then had to close the
 * drawer, switch to the Logs tab, and find the same pod again by name in a namespace select. The
 * pod was already identified — the console simply threw that away.
 *
 * ## The one non-obvious rule
 *
 * A restarting pod's *current* container started seconds ago, so its log is empty or holds only a
 * startup banner. The evidence for why it died is in the instance before the restart. That is why
 * `previous: true` is offered as its own step rather than as the only step: the current log is
 * still the right thing to read for a pod that is merely slow or wedged, and only a pod with
 * `restarts > 0` has a previous instance to read at all — offering the link otherwise would lead
 * to a "no previous instance" empty state, which is a link that lies.
 */
import type { ResourceRef } from '../resources/types';

/** The shape this module needs from a resolved pod row. Deliberately not the full `PodRow`. */
export interface PodLike {
  namespace: string;
  name: string;
  restarts?: number | null;
  containers?: { name: string; restarts?: number | null }[] | null;
}

/** One onward step, as data. The caller turns it into a control. */
export interface StepSpec {
  label: string;
  why: string;
  kind: 'logs' | 'logs-previous';
  target: { namespace: string; pod: string; container?: string | null };
}

function isPodLike(row: unknown): row is PodLike {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return typeof r.namespace === 'string' && typeof r.name === 'string';
}

/**
 * How many restarts the selected thing has.
 *
 * For a Container ref that is *that container's* count, not the pod's — a pod whose sidecar is
 * flapping while the app container is fine should not offer "logs before the last restart" on the
 * app container, because the app container never restarted and its previous log does not exist.
 */
function restartsFor(row: PodLike, ref: ResourceRef): number {
  if (ref.container) {
    const c = (row.containers ?? []).find(x => x.name === ref.container);
    return Number(c?.restarts ?? 0) || 0;
  }
  return Number(row.restarts ?? 0) || 0;
}

/**
 * The steps for one selected resource. Empty for Kinds that have no evidence screen — which is
 * most of them, and the drawer renders nothing rather than an empty heading.
 */
export function investigationSteps(ref: ResourceRef, row: unknown): StepSpec[] {
  if (ref.kind !== 'Pod' && ref.kind !== 'Container') return [];
  if (!isPodLike(row)) return [];

  // The pod's identity comes from the row, not the ref: for a Container ref, `ref.name` is the
  // pod's name by convention (see `ResourceRef.container`), but reading it from the resolved row
  // is what keeps that convention from being restated here and drifting.
  const target = { namespace: row.namespace, pod: row.name, container: ref.container ?? null };
  const restarts = restartsFor(row, ref);
  const what = ref.container ? `container ${ref.container}` : 'this pod';

  const steps: StepSpec[] = [
    {
      label: 'View live logs',
      why: `streams ${what} in the Logs tab`,
      kind: 'logs',
      target
    }
  ];

  if (restarts > 0) {
    steps.push({
      label: 'Logs before the last restart',
      why:
        restarts === 1
          ? 'restarted once — the reason is in the previous instance'
          : `restarted ${restarts} times — the reason is in the previous instance`,
      kind: 'logs-previous',
      target
    });
  }

  /*
   * No "Workload events" step, and the reason is an invariant rather than an oversight.
   *
   * `PodRow` (api.ts) carries no `ownerReferences` — it has `node`, `phase`, `containers`,
   * requests and usage, and nothing that names the Deployment or StatefulSet above it. The only
   * way to produce a workload link from this payload would be to strip the generated suffixes off
   * the pod name and hope the remainder is the controller: `my-api-7d9f8b4c6-x2k9p` → `my-api`.
   *
   * That is string similarity, which this product does not do. It is also wrong often enough to
   * matter — a StatefulSet pod's suffix is an ordinal, two controllers in a namespace can share a
   * prefix, and a hand-created pod has no controller at all — and a relationship link that is
   * usually right is worse than none, because an operator cannot tell which case they are in.
   *
   * The step becomes available the moment the pod collector returns the owner reference it
   * already has server-side. Until then the Related panel's Node and Container entries are the
   * onward links, and both are real.
   */

  return steps;
}
