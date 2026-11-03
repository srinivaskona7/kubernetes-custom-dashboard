/**
 * "What went wrong" — the click-through explanation behind a failure badge.
 *
 * `errors.ts` explains a failure of *this console's own read*. This file explains a failure **in the
 * cluster** that the read succeeded in observing: a container the kernel killed, a container about
 * to be killed, a request Envoy rejected. Same four-part discipline, one part more:
 *
 *   summary      one plain-language line — what happened, in the operator's words
 *   rootCause    the technical mechanism, named precisely enough to argue with
 *   remediation  what to change, in order, with the decision left to the operator
 *   commands     copyable `kubectl`, with the real namespace and pod already in it
 *
 * ## The rule the tests enforce
 *
 * **An explanation may only assert what was observed.** The kubelet's `OOMKilled` is a kill that
 * happened, so its copy is past tense. A container at 91% of its limit has not been killed, so its
 * copy is conditional — and never borrows the kill's wording, because an operator who reads "was
 * killed" on a running pod goes looking for a restart that never occurred. An HTTP code this file
 * has no entry for gets a fallback that says so; a plausible invented cause is worse than a gap,
 * because nothing on the screen tells the reader it was invented.
 *
 * ## Commands
 *
 * Read-first: `describe`, `logs`, `top`. A mutating command appears only as the last step and only
 * where the fix genuinely is a spec change — and it is *text for the operator's own shell*. This
 * console holds a read-only credential and runs none of it. A command is never emitted with a
 * placeholder left in it; the test greps for that, because a half-substituted command pasted into a
 * production shell is the one failure mode a copy button can cause on its own.
 *
 * ## What is deliberately not here
 *
 * **Image drift.** It had an entry and it was removed: `DriftInspector` already explains drift with
 * the two image references side by side, the owner-resolution reason, and the one quick-fix command —
 * evidence a generic registry entry cannot carry. Two accounts of the same finding is how they drift
 * apart, so drift has exactly one, and it is the specific one.
 */
import type { Tone } from './components/ui';

export interface Diagnosis {
  /** The registry key, for the test that enumerates coverage and for an analytics-free label. */
  subject: string;
  title: string;
  summary: string;
  rootCause: string;
  remediation: string[];
  /** Copyable, fully substituted, and safe to read before running. */
  commands: string[];
  tone: Tone;
  /** False when this is the honest fallback rather than tailored copy. */
  known: boolean;
}

/** Where the badge was clicked. Pod-scoped subjects carry it; an HTTP code has no pod. */
interface Where {
  namespace: string;
  pod: string;
  container?: string;
}

export type DiagnosisSubject =
  | ({ kind: 'oom-killed' } & Where)
  | ({ kind: 'oom-risk'; percent: number; limit: string } & Where)
  | ({ kind: 'cpu-throttle'; percent: number; limit: string } & Where)
  | ({ kind: 'crashloop' } & Where)
  | { kind: 'http'; code: number };

/** Percent, for a sentence. `0.914` reads as `91%`; nobody acts on the decimal. */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** The two read-only commands every pod subject starts with. Order is the reading order. */
function podReads({ namespace, pod, container }: Where): string[] {
  return [
    `kubectl describe pod ${pod} -n ${namespace}`,
    container
      ? `kubectl logs ${pod} -n ${namespace} -c ${container} --previous --tail=200`
      : `kubectl logs ${pod} -n ${namespace} --previous --tail=200`
  ];
}

/** Every subject with tailored copy, for the test that keeps this registry honest. */
export const DIAGNOSED_SUBJECTS: readonly string[] = [
  'oom-killed',
  'oom-risk',
  'cpu-throttle',
  'crashloop',
  'http:0',
  'http:401',
  'http:403',
  'http:404',
  'http:502',
  'http:503',
  'http:504'
];

const HTTP: Record<number, Omit<Diagnosis, 'subject' | 'known' | 'commands'> & { commands?: string[] }> = {
  0: {
    title: 'The connection produced no HTTP response',
    summary:
      'Envoy recorded response code 0: the connection never answered at all. That is not a server error — no HTTP response was produced in either direction.',
    rootCause:
      'A client that hung up before the response, a TLS handshake that failed, or a health probe closing the connection early. Envoy logs the request because the connection existed, and logs code 0 because nothing HTTP came back.',
    remediation: [
      'Read the response flags on the hop: they say which side went away and when.',
      'On an ingress listener, check whether the traffic is plain HTTP arriving on a TLS port — a protocol mismatch produces exactly this.',
      'Compare the count against the cluster’s health-probe interval before treating it as an incident: probes are the most common source of code 0.'
    ],
    tone: 'unknown'
  },
  401: {
    title: 'The request carried no credential the answering side accepts',
    summary: 'The caller was not authenticated. Which side said so is in `response_code_details` on the failing hop.',
    rootCause:
      '`via_upstream` means the workload answered 401 itself — an approuter or app with no session or an expired token for this caller — and the mesh only relayed it. `jwt_authn_access_denied` means an Istio RequestAuthentication rejected the JWT at the proxy, and the workload never saw the request.',
    remediation: [
      'Read `response_code_details` on the failing hop to tell an application 401 from a mesh one.',
      'For `via_upstream`, check the workload’s own logs at the same timestamp: a steady 401 on one polling path is usually a client without a session, retrying.',
      'For `jwt_authn_access_denied`, compare the RequestAuthentication issuer and JWKS with the token the client sends.'
    ],
    commands: ['kubectl get requestauthentications -A'],
    tone: 'warn'
  },
  403: {
    title: 'The request was refused by a policy, not by the application',
    summary: 'Something in the path rejected this request before the workload saw it.',
    rootCause:
      'An Istio AuthorizationPolicy denial, a missing or invalid JWT at the gateway, or Kubernetes RBAC when the target is the API server. Envoy’s response_code_details names which — `rbac_access_denied_matched_policy` points at an AuthorizationPolicy by name.',
    remediation: [
      'Read `response_code_details` on the failing hop. It names the policy that matched.',
      'Check whether the caller’s workload identity (its ServiceAccount) is in that policy’s `from` rules.',
      'For an edge 403, confirm the RequestAuthentication issuer matches the token the client is actually sending.'
    ],
    commands: ['kubectl get authorizationpolicies -A'],
    tone: 'warn'
  },
  404: {
    title: 'No route matched the request',
    summary: 'The host and path combination reached the mesh and nothing was configured to serve it.',
    rootCause:
      'The Gateway admits the host but no VirtualService claims that path, or the request’s Host header does not match any configured host. Envoy answers from the route table, so the workload is never contacted and its logs will show nothing.',
    remediation: [
      'Check the Host header the client actually sent against the hosts the Gateway publishes.',
      'Confirm a VirtualService binds that host to the Gateway and matches the path prefix.',
      'A 404 with `NR` in the response flags means no route existed at all, which is configuration rather than a missing page.'
    ],
    commands: ['kubectl get gateways,virtualservices -A'],
    tone: 'warn'
  },
  502: {
    title: 'The upstream answered, and the answer was unusable',
    summary: 'The proxy reached the workload and could not parse or complete what came back.',
    rootCause:
      'The upstream closed the connection mid-response, spoke a protocol the proxy did not expect (plain HTTP on an HTTPS port, or HTTP/1 on an h2 port), or crashed while responding. `UPE`, `UC` and `UF` in the response flags each point at a different one of those.',
    remediation: [
      'Check whether the target container restarted around the same timestamp — a crash mid-response reads as a 502 at the edge.',
      'Confirm the Service port’s `appProtocol`/name matches what the workload actually speaks.',
      'Read the upstream container’s own logs for the same second; the failure is usually visible there and not in the proxy.'
    ],
    tone: 'bad'
  },
  503: {
    title: 'There was nothing healthy to send the request to',
    summary: 'The proxy had no available upstream endpoint, so it rejected the request itself.',
    rootCause:
      'No ready endpoint behind the Service (`UH`), the circuit breaker’s connection pool was full (`UO`), or a retry budget was exhausted. This is the proxy’s own answer — the workload is never contacted, so a 503 with no matching backend log line is expected rather than mysterious.',
    remediation: [
      'Check the EndpointSlice for the target Service: no ready address is the single most common cause.',
      'If endpoints exist, look for a DestinationRule with connection-pool limits — `UO` means the pool, not the workload, refused.',
      'Confirm the pods’ readiness probes are actually passing; a failing probe removes the endpoint without stopping the pod.'
    ],
    tone: 'bad'
  },
  504: {
    title: 'The upstream took longer than the route allows',
    summary: 'The request was cut off for being too slow, not for being wrong.',
    rootCause:
      'The route’s timeout elapsed before the upstream finished (`UT` in the response flags). The default Istio route timeout applies when a VirtualService sets none, and a slow dependency several hops in surfaces here as a timeout at the edge.',
    remediation: [
      'Compare the hop durations: the slowest hop is where the time went, and it is rarely the one that reported the timeout.',
      'Check whether the upstream container is being CPU-throttled — a throttled container is slow without being unhealthy.',
      'Raise the route timeout only after the latency is understood; a longer timeout turns a fast failure into a slow one.'
    ],
    tone: 'bad'
  }
};

function httpFallback(code: number): Diagnosis {
  return {
    subject: `http:${code}`,
    title: `HTTP ${code}`,
    summary: `Envoy recorded response code ${code} for this request.`,
    rootCause:
      'This console does not have specific guidance for this status code. Inventing a cause would send whoever is on call down a path nothing observed supports, so the evidence is shown instead: the response flags and `response_code_details` on the hop are Envoy’s own account of what happened.',
    remediation: [
      'Read the response flags and `response_code_details` on the failing hop — they are the proxy’s verbatim reason.',
      'Check the upstream workload’s own logs for the same timestamp.'
    ],
    commands: [],
    tone: 'warn',
    known: false
  };
}

export function diagnose(subject: DiagnosisSubject): Diagnosis {
  if (subject.kind === 'http') {
    const entry = HTTP[subject.code];
    if (!entry) return httpFallback(subject.code);
    return {
      subject: `http:${subject.code}`,
      title: entry.title,
      summary: entry.summary,
      rootCause: entry.rootCause,
      remediation: entry.remediation,
      commands: entry.commands ?? [],
      tone: entry.tone,
      known: true
    };
  }

  const scope = `${subject.namespace}/${subject.pod}`;
  switch (subject.kind) {
    case 'oom-killed':
      return {
        subject: 'oom-killed',
        title: 'This container was killed for exceeding its memory limit',
        summary: `The kubelet reported OOMKilled for ${subject.container ?? 'a container'} in ${scope}: it reached its memory limit and the Linux kernel terminated it.`,
        rootCause:
          'A container that reaches its cgroup memory limit is killed, not throttled — the kernel’s OOM killer ends the process immediately and the kubelet restarts it. This is the kubelet’s own termination reason, read from the container status, not a figure derived from a usage sample.',
        remediation: [
          'Read the previous instance’s logs. The last lines before the kill are the only record of what it was doing.',
          'Decide between a real leak and a limit set below the workload’s working set — the restart count tells you which: a leak kills repeatedly and on a schedule.',
          'Raise the memory limit only if the working set is genuinely that size. A higher limit on a leaking container delays the same kill.'
        ],
        commands: [...podReads(subject), `kubectl get events -n ${subject.namespace} --field-selector involvedObject.name=${subject.pod}`],
        tone: 'bad',
        known: true
      };
    case 'oom-risk':
      return {
        subject: 'oom-risk',
        title: 'This container is close to its memory limit',
        summary: `${subject.container ?? 'A container'} in ${scope} is using ${pct(subject.percent)} of its ${subject.limit} memory limit. Nothing has been terminated — at the limit, the kernel would kill it rather than slow it down.`,
        rootCause:
          'A forecast, not a verdict: a live sample from metrics-server measured against the limit in the pod spec. Memory is not compressible, so there is no throttling band before the kill — the container runs normally until the allocation that crosses the limit.',
        remediation: [
          'Watch the trend rather than this sample. A flat 90% is a correctly-sized container; a climb to 90% is a leak.',
          'Check whether the workload’s own cache or heap settings are aware of the limit — a JVM or Node heap sized above the cgroup limit is killed by design.',
          'If the working set really is this size, raise the limit before it is hit, and the request with it so the scheduler places it honestly.'
        ],
        commands: [
          `kubectl top pod ${subject.pod} -n ${subject.namespace} --containers`,
          `kubectl describe pod ${subject.pod} -n ${subject.namespace}`
        ],
        tone: 'warn',
        known: true
      };
    case 'cpu-throttle':
      return {
        subject: 'cpu-throttle',
        title: 'This container is being throttled at its CPU limit',
        summary: `${subject.container ?? 'A container'} in ${scope} is at ${pct(subject.percent)} of its ${subject.limit} CPU limit, so the scheduler is making it wait. It is slow, and it is not being restarted.`,
        rootCause:
          'The CFS quota is enforced per 100ms period: once a container spends its slice it is descheduled until the next one. Latency rises while CPU usage looks like a flat line at the limit, which is why a throttled container reads as healthy on every liveness probe and still times out under load.',
        remediation: [
          'Compare the request and the limit. A limit near the request leaves no burst room for exactly the spikes that need it.',
          'Look for a 504 or a rising p95 on the same workload in Ingress & Traffic — throttling surfaces there first.',
          'Raise or remove the CPU limit before adding replicas; more throttled replicas are still throttled.'
        ],
        commands: [
          `kubectl top pod ${subject.pod} -n ${subject.namespace} --containers`,
          `kubectl describe pod ${subject.pod} -n ${subject.namespace}`
        ],
        tone: 'warn',
        known: true
      };
    case 'crashloop':
      return {
        subject: 'crashloop',
        title: 'This container keeps failing to start',
        summary: `${scope} is in CrashLoopBackOff: it starts, exits, and the kubelet is waiting longer between each attempt.`,
        rootCause:
          'The backoff is a symptom, never a cause — the kubelet is reporting that the process exited, not why. The exit code and the previous instance’s last log lines are the only evidence of the actual failure, and a failing liveness probe produces the same loop from a process that is otherwise fine.',
        remediation: [
          'Read the previous instance’s logs first. This is where the cause is, and it is usually one line.',
          'Check the exit code in the container status: 1 is the application, 137 is a kill (often OOM), 139 is a segfault.',
          'Rule out configuration before code: a missing Secret key or ConfigMap entry exits instantly and repeatedly.'
        ],
        commands: podReads(subject),
        tone: 'bad',
        known: true
      };
  }
}
