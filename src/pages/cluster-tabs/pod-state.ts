/*
  Pod state, as two separate facts.

  A pod's `phase` (Running/Pending/Succeeded/Failed/Unknown) and a *container's* waiting reason
  (CrashLoopBackOff, ImagePullBackOff, CreateContainerConfigError) are different facts from
  different fields. Rendering `reason ?? phase` in one slot printed `CrashLoopBackOff` where the
  phase belongs — and no Kubernetes phase is ever called that, so the cell named a fact the API
  does not report while hiding the one it does.

  `Running` is also not `Ready`. A pod can be Running with `ContainersReady=False` — a failed
  readiness probe, 0/1 containers ready, taking no traffic — and a green `Running` pill over that
  state tells an operator the opposite of the truth. Both inputs are already on the wire
  (`srv/fleet/collectors/workloads.js` publishes `conditions` incl. Ready/ContainersReady, and
  per-container `ready`), so nothing here is inferred or invented.

  JSX-free on purpose: `app/fleet-ui` runs vitest with `environment: 'node'` and jsdom cannot be
  installed here, so every rule that can be tested has to live outside a component.
*/

/** The minimum of `PodRow` this module reads. Kept structural so both call sites satisfy it. */
export interface PodStateInput {
  /** Only used to name the pod in a workload-level tooltip. */
  name?: string;
  phase: string;
  reason: string | null;
  isOOMKilled?: boolean;
  conditions?: readonly { type: string; status: string }[];
  containers?: readonly { name: string; ready: boolean; init?: boolean; reason?: string | null }[];
}

export interface PodState {
  /** The phase, and only ever the phase. Never a container reason. */
  phase: string;
  /** The kubelet's container reason, when there is one. Rendered beside the phase, never inside it. */
  reason: string | null;
  /** Which container the reason came from, so the operator knows where to look. Null if unattributable. */
  containerRef: string | null;
  /** `ready/total` over the pod's regular containers, or null when the payload carries no statuses. */
  readyText: string | null;
  /**
   * `ok` is reserved for Running with ContainersReady=True (and for Succeeded, a completed pod for
   * which readiness does not apply). Everything else is warn, and a reason or a failed phase is bad.
   */
  tone: 'ok' | 'warn' | 'bad';
}

/** 'True' | 'False' | null — null means the condition was not reported at all, which is not False. */
function condition(input: PodStateInput, type: string): string | null {
  const hit = (input.conditions ?? []).find(c => c.type === type);
  return hit ? hit.status : null;
}

export function podState(input: PodStateInput): PodState {
  const phase = input.phase || 'Unknown';
  const reason = input.reason ?? null;
  const regular = (input.containers ?? []).filter(c => !c.init);
  const ready = regular.filter(c => c.ready).length;
  // Succeeded pods have exited; `0/1 ready` on a completed job is noise, not a finding.
  const readyText = regular.length > 0 && phase !== 'Succeeded' ? `${ready}/${regular.length}` : null;
  const containersReady = condition(input, 'ContainersReady');

  const attributed = reason
    ? ((input.containers ?? []).find(c => c.reason === reason) ?? null)
    : null;

  let tone: PodState['tone'];
  if (reason || input.isOOMKilled) tone = 'bad';
  else if (phase === 'Failed' || phase === 'Unknown') tone = 'bad';
  else if (phase === 'Succeeded') tone = 'ok';
  else if (phase === 'Running') {
    // True, and nothing else. A missing ContainersReady condition is unknown readiness, and unknown
    // readiness is not a green verdict.
    tone = containersReady === 'True' ? 'ok' : 'warn';
  } else tone = 'warn';

  return { phase, reason, containerRef: attributed ? attributed.name : null, readyText, tone };
}

/** `CrashLoopBackOff (container web)`, or just the reason when it cannot be attributed. */
export function reasonLabel(s: PodState): string | null {
  if (!s.reason) return null;
  return s.containerRef ? `${s.reason} (container ${s.containerRef})` : s.reason;
}

/*
  The workload `State` column.

  `srv/fleet/collectors/workloads.js` used to substitute a crashing container's waiting reason for
  the controller's state, so this column could read `CrashLoopBackOff` for a Deployment — a string
  no Deployment ever reports, naming neither the pod nor the container. That substitution is gone
  (`const state = r.state;`), and the collector now publishes the diagnosis separately and
  attributed, as `podIssues: [{reason, pods, containers: [{namespace, pod, container}]}]`.

  So this function no longer repairs a wrong state; it renders the controller state PLUS the
  attribution the server already computed. It must never match a reason against `state` — those
  are two different vocabularies, and comparing them is what made the previous version dead code:
  `state` is only ever `Ready`/`Progressing`/`Unavailable`, so no container reason could equal it.
*/
export interface WorkloadStateSummary {
  text: string;
  title: string;
}

export interface WorkloadPodIssueInput {
  reason: string;
  pods: number;
  containers?: readonly { namespace: string; pod: string; container: string }[];
}

export function workloadStateSummary(
  state: string,
  podIssues: readonly WorkloadPodIssueInput[] = []
): WorkloadStateSummary {
  if (podIssues.length === 0) return { text: state, title: state };

  // Worst first, and the reason named: "Progressing — 2 pods CrashLoopBackOff". The count is pods,
  // not containers, because two crashing containers in one pod is one broken pod.
  const ranked = [...podIssues].sort((a, b) => b.pods - a.pods || a.reason.localeCompare(b.reason));
  const phrase = (i: WorkloadPodIssueInput) => `${i.pods} pod${i.pods === 1 ? '' : 's'} ${i.reason}`;

  const lines = ranked.map(i => {
    const where = (i.containers ?? []).map(c => `  ${c.namespace}/${c.pod} (container ${c.container})`);
    return [phrase(i), ...where].join('\n');
  });

  return {
    text: `${state} — ${ranked.map(phrase).join(', ')}`,
    title: [
      `${state} is this controller's own state. The reasons below are container waiting reasons`,
      'from its pods, which is a different fact — no controller ever reports one.',
      '',
      ...lines
    ].join('\n')
  };
}
