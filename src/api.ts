/**
 * The API client and the types the server actually emits.
 *
 * These types are hand-maintained against srv/fleet/*, and the shapes are checked in
 * development by running the UI against `npm run fleet:dev`, which serves the real
 * collectors over the real transport against a cluster you onboard — so a shape that
 * appears here has been produced by the same code that will produce it in the cluster.
 */

import { logger } from './logger';

export type TokenStatus = 'valid' | 'expiring' | 'expired' | 'unseeded' | 'unknown';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na';
export type Verdict = 'compliant' | 'warnings' | 'findings' | 'system';

export interface Cluster {
  id: string;
  displayName: string;
  env: string;
  apiUrl: string;
  namespace: string;
  serviceAccount: string;
  enabled: boolean;
  authMode?: 'token' | 'oidc';
  /** 'baked' for a cluster that ships in the image. */
  onboardedVia: 'baked' | 'token' | 'kubeconfig' | 'oidc';
  /** False only when a pasted token was refused permission to mint its own successor. */
  renewable: boolean;
}

export interface TokenHealth {
  status: TokenStatus;
  expiresAt: string | null;
  expiresInMs: number | null;
  renewedAt: string | null;
  lastError: string | null;
  dueForRenewal: boolean;
}

export interface FleetError {
  code: string;
  message: string;
  cluster?: string;
  needsReseed: boolean;
}

/** Every fan-out endpoint returns this envelope: the failure is data, not an exception. */
export interface Envelope<T> {
  cluster: Cluster;
  /**
   * Three states, not two. `true` read, `false` tried and failed, `null` not read at all — a
   * registered cluster this fan-out did not cover, which in practice means one onboarded a
   * moment ago. `null` must never be rendered as a failure: it used to be `false`, and the rail
   * greeted every newly added cluster with a red "Unreachable" about a cluster nothing had
   * contacted. `notRead` says which of the two non-`true` cases it is.
   */
  ok: boolean | null;
  /** Why there is no reading. Only set when `ok` is not `true`. */
  notRead?: 'pending' | 'disabled';
  data?: T;
  error?: FleetError;
  token?: TokenHealth;
  registered?: boolean;
  removable?: boolean;
}

/** Present on every collector that reads metrics.k8s.io, which is an optional add-on. */
export interface MetricsAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * How complete a set of readings is, in the collectors' own vocabulary of labels.
 *
 * Every fan-out endpoint publishes both lists twice: once on the fleet `summary` as the
 * union, and once on each per-cluster slot so the console can say *which* cluster. They mean
 * opposite things and are never merged:
 *
 *   unavailable  the read did not happen — 401, 403, timeout. Any count derived from it is
 *                not a number at all; the UI renders an em-dash, never a digit.
 *   truncated    the read happened and its items are real, but it stopped at the client's
 *                paging ceiling. The count is a FLOOR — `≥ 4,182`, never a dash.
 *
 * Both are optional here, because a server older than the field sends neither and the UI has
 * to keep working against it. `components/unavailable.tsx` is the only place that interprets
 * them; nothing else should branch on them directly.
 *
 * Not to be confused with `LogTail.truncated`, a boolean about log output cut at a byte
 * limit. Different field, different meaning, unrelated.
 */
export interface Completeness {
  unavailable?: string[];
  truncated?: string[];
}

/** One cluster's slot in a fan-out response, with its own completeness lists. */
export interface ClusterSlot extends Completeness {
  id: string;
  ok: boolean;
  error: FleetError | null;
}

export interface NodeGroup {
  name: string;
  nodeCount: number;
  readyNodes: number;
  instanceTypes: string[];
  zones: string[];
  podsScheduled: number;
  podCapacity: number;
  podUsagePercent: number | null;
  cpuAllocatable: number;
  cpuRequested: number;
  cpuRequestedPercent: number | null;
  cpuUsage?: number | null;
  cpuUsagePercent?: number | null;
  memoryAllocatable: number;
  memoryRequested: number;
  memoryRequestedPercent: number | null;
  memoryUsage?: number | null;
  memoryUsagePercent?: number | null;
}

export interface NodeRow {
  name: string;
  ready: boolean;
  role: string;
  nodeGroup?: string;
  version: string | null;
  cpuCapacity: number;
  memoryCapacity: number;
  /** Capacity minus kubelet/system reservations — the number the scheduler uses. */
  cpuAllocatable: number;
  memoryAllocatable: number;
  pods: number;
  podCapacity: number | null;
  podUsagePercent?: number | null;
  cpuRequested?: number;
  cpuRequestedPercent?: number | null;
  memoryRequested?: number;
  memoryRequestedPercent?: number | null;
  cpuUsage: number | null;
  memoryUsage: number | null;
  cpuUsagePercent: number | null;
  memoryUsagePercent: number | null;
  zone: string | null;
  instanceType: string | null;
  os: string | null;
  kernelVersion: string | null;
  containerRuntime: string | null;
  createdAt: string | null;
  unschedulable: boolean;
  taints: string[];
  problems: { type: string; reason: string | null; message: string | null }[];
  podsList?: {
    name: string;
    namespace: string;
    phase: string;
    restarts?: number;
    cpuRequested?: number;
    memoryRequested?: number;
  }[];
}

export interface Capacity {
  /** Raw hardware total, summed over nodes. Not the scheduler's denominator. */
  capacity: number;
  /**
   * Capacity minus the kubelet/system reservation — what the scheduler actually divides up,
   * and therefore the only honest denominator for "how full is this cluster". `percent` and
   * `usedPercent` are both computed against THIS, not `capacity`. Anything labelled
   * "allocatable" on screen must read this field: summing `capacity` while calling it
   * allocatable is what made the cluster header disagree with its own node rows.
   */
  allocatable: number;
  requested: number;
  percent: number | null;
  /** Live usage from metrics-server; null when it is not installed. */
  used: number | null;
  usedPercent: number | null;
}

export interface Health {
  nodes: {
    total: number;
    ready: number;
    unschedulable: number;
    withProblems: number;
    zones: string[];
    nodeGroups?: NodeGroup[];
    items: NodeRow[];
  };
  kubernetesVersion: string | null;
  kubernetesVersions: string[];
  pods: {
    total: number;
    running: number;
    pending: number;
    failed: number;
    succeeded: number;
    restarts: number;
    byPhase: Record<string, number>;
  };
  capacity: { cpu: Capacity; memory: Capacity };
  metrics: MetricsAvailability;
}

export interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  /** The literal thing that was looked at, e.g. `label istio-injection`. */
  inspected: string | null;
  detail: string | null;
}

export interface NamespaceRow {
  cluster: string;
  namespace: string;
  system: boolean;
  /**
   * Pods in this namespace. **Null** when the pod list was refused or came back truncated — a
   * short list is an undercount that looks like a count, and there is no way to know which
   * namespace lost rows, so none of them get a number. Optional: a server predating the field
   * omits it, which reads as null too.
   */
  pods?: number | null;
  verdict: Verdict;
  findings: number;
  warnings: number;
  checks: Check[];
}

export interface ComplianceReport {
  summary: {
    clusters: number;
    unreachable: number;
    audited: number;
    compliant: number;
    withWarnings: number;
    withFindings: number;
  } & Completeness;
  clusters: ClusterSlot[];
  namespaces: NamespaceRow[];
  collectedAt: string;
}

/**
 * Which of a container's request/limit keys the spec actually sets, read with `hasOwnProperty` by
 * `srv/fleet/collectors/workloads.js`. Presence only — never a value, and never a verdict.
 */
export interface QosBasis {
  cpuRequestSet: boolean;
  cpuLimitSet: boolean;
  memoryRequestSet: boolean;
  memoryLimitSet: boolean;
}

export interface ContainerRow {
  name: string;
  image: string;
  /** The digest the kubelet resolved `image` to, or null if it has not pulled yet. */
  imageDigest: string | null;
  /** Env variable NAMES only — values never leave the cluster. */
  envKeys: string[];
  /** Whole-block env sources: the ConfigMaps and Secrets this container reads. */
  envFrom: { kind: 'ConfigMap' | 'Secret'; name: string }[];
  init: boolean;
  ready: boolean;
  restarts: number;
  state: string;
  reason: string | null;
  /**
   * The reason the *previous* instance of this container terminated, per the kubelet. `OOMKilled`
   * here is the only proof this console has that a container was killed for memory — it is never
   * inferred from a usage figure. Null when the container has no previous instance.
   */
  lastStateReason: string | null;
  /** The previous instance's exit code. `0` is a real value and distinct from "no exit code". */
  lastExitCode: number | null;
  /** True when this or the previous instance terminated with reason OOMKilled. */
  isOOMKilled: boolean;
  /** The image the kubelet is actually running, which can differ from the spec's `image`. */
  runtimeImage: string | null;
  /**
   * Whether each request/limit KEY exists in the container spec, independent of its value:
   * `requests: { cpu: "0" }` is `cpuRequestSet: true`. QoS turns on presence, not value, and the
   * four numbers below are `number`, so an absent request and an explicit `"0"` are the same `0`
   * there. Read the class itself from `PodRow.qosClass` — the kubelet's own verdict — and use this
   * only to EXPLAIN it. Optional and nullable on purpose: a payload without it — an older `srv` than
   * this build, or a fixture — is unknown presence, never absent presence, and `qos.ts` reads it
   * that way.
   */
  qosBasis?: QosBasis | null;
  /** A restartable init container (`restartPolicy: Always`), which runs for the pod's life. */
  sidecar?: boolean;
  cpuRequest: number;
  cpuLimit: number;
  memoryRequest: number;
  memoryLimit: number;
  cpuUsage: number | null;
  memoryUsage: number | null;
}

export interface PodRow {
  name: string;
  namespace: string;
  phase: string;
  restarts: number;
  /** True when any container in this pod carries the kubelet's OOMKilled reason. */
  isOOMKilled: boolean;
  reason: string | null;
  message: string | null;
  startedAt: string | null;
  /** Which node this pod landed on. Null while it is still Pending. */
  node: string | null;
  nodeSelector: Record<string, string> | null;
  podIP: string | null;
  qosClass: string | null;
  /**
   * PodScheduled / Initialized / ContainersReady / Ready, with the scheduler's own reason and
   * message. The only admissible source for "why is this pod not placed" — a cause such as
   * "Insufficient cpu" is read from here, never inferred from cluster capacity.
   */
  conditions: { type: string; status: string; reason: string | null; message: string | null }[];
  containers: ContainerRow[];
  cpuRequest: number;
  cpuLimit: number;
  memoryRequest: number;
  memoryLimit: number;
  cpuUsage: number | null;
  memoryUsage: number | null;
}

/**
 * One distinct container waiting reason carried by this workload's pods, with the containers that
 * carry it. Built by `srv/fleet/collectors/workloads.js` so the controller's `state` slot never
 * holds a container reason: `state` stays `Ready`/`Progressing`/`Unavailable`, and the diagnosis
 * is reported here, attributed. An empty array means no pod reports a back-off/error waiting
 * reason — it is not a statement that the workload is healthy; `state` says that.
 */
export interface WorkloadPodIssue {
  reason: string;
  /** Pods, not container instances: two crashing containers in one pod is one broken pod. */
  pods: number;
  containers: { namespace: string; pod: string; container: string }[];
}

export interface WorkloadRow {
  name: string;
  namespace: string;
  cluster: string;
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  ready: number;
  desired: number;
  state: string;
  podIssues: WorkloadPodIssue[];
  healthy: boolean;
  image: string | null;
  restarts: number;
  createdAt: string;
  /** Distinct nodes this workload's pods are spread across. */
  nodes: string[];
  restartedAt: string | null;
  updatedReplicas: number;
  availableReplicas: number;
  generation: number | null;
  observedGeneration: number | null;
  restartable: boolean;
  cpuRequest: number;
  cpuLimit: number;
  memoryRequest: number;
  memoryLimit: number;
  cpuUsage: number | null;
  memoryUsage: number | null;
  pods: PodRow[];
}

export interface Workloads {
  summary: {
    total: number;
    notReady: number;
    restarts: number;
    pods: number;
    cpuUsage: number | null;
    memoryUsage: number | null;
    cpuRequest: number;
    memoryRequest: number;
    // Every count above is a floor when either list is non-empty: a 403 or a timeout on one of
    // this collector's reads leaves those workloads out of all of them.
  } & Completeness;
  metrics: MetricsAvailability;
  items: WorkloadRow[];
}

/** The fleet-wide sweep: every cluster's workloads flattened into one list. */
export interface FleetWorkloads {
  summary: { clusters: number; unreachable: number; total: number; notReady: number; restarts: number } & Completeness;
  clusters: ClusterSlot[];
  items: WorkloadRow[];
  collectedAt: string;
}

export interface RolloutStatus {
  cluster: string;
  namespace: string;
  name: string;
  kind: string;
  desired: number;
  updated: number;
  available: number;
  ready: number;
  complete: boolean;
  restartedAt: string | null;
  conditions: { type: string; status: string; reason: string | null; message: string | null }[];
}

export interface EventRow {
  namespace: string;
  cluster: string;
  reason: string;
  message: string;
  count: number;
  object: string | null;
  at: string | null;
}

// ------------------------------------------------------------------------- logs

export interface LogContainer {
  name: string;
  image: string;
  init: boolean;
  ready: boolean;
  restarts: number;
  /** `previous` only works when an earlier instance exists; the toggle hides otherwise. */
  hasPrevious: boolean;
  state: string;
  reason: string | null;
}

export interface LogPod {
  name: string;
  namespace: string;
  cluster: string;
  node: string | null;
  phase: string;
  restarts: number;
  startedAt: string | null;
  containers: LogContainer[];
}

export interface PodInventory {
  summary: { pods: number; namespaces: number; containers: number };
  items: LogPod[];
}

export interface LogLine {
  at: string | null;
  level: 'fatal' | 'error' | 'warn' | 'debug' | null;
  message: string;
}

export interface LogTail {
  cluster: string;
  namespace: string;
  pod: string;
  container: string | null;
  previous: boolean;
  tailLines: number;
  truncated: boolean;
  /** The byte budget was reached, independent of the line budget. Absent from an older server. */
  bytesTruncated?: boolean;
  /** Lines dropped because the byte cut landed inside them. Absent from an older server. */
  partialLinesDropped?: number;
  lines: LogLine[];
  fetchedAt: string;
}

export interface LogQuery {
  namespace: string;
  pod: string;
  container?: string;
  tailLines?: number;
  previous?: boolean;
  sinceSeconds?: number;
}

// -------------------------------------------------------------------- onboarding

/**
 * Three ways to add a cluster, and the server picks by which credential is present.
 *
 * `token` is the preferred one: the operator has already created the identity with
 * kubectl, so no admin credential reaches the application at all. `kubeconfig` lets the
 * application create the identity itself, which needs an admin credential for the length
 * of one request. **Both together** is the SSO case — the file supplies the API server and
 * its CA, the pasted token supplies the credential, and the file's own exec/OIDC
 * credential is ignored. That combination is what the Add Cluster page sends for a
 * kubeconfig with no static token, so an operator never has to paste a PEM by hand.
 */
export interface OnboardRequest {
  name: string;
  env?: string;
  /** A service-account token. Requires apiUrl and caData alongside it, or a kubeconfig. */
  token?: string;
  apiUrl?: string;
  caData?: string;
  /** An admin kubeconfig. Carries its own apiUrl and CA. */
  kubeconfig?: string;
  contextName?: string;
  authMode?: 'token' | 'oidc';
  /**
   * Confirm that an id already in the fleet may be taken over.
   *
   * The server answers 409 `CLUSTER_EXISTS` for any existing id, and this is the only way past
   * it. Replacing repoints the fleet at a different API server under a name operators already
   * trust, so the console never sends it on the first attempt — it sends it after the operator
   * has been shown the 409 and said yes. Strict `true`; the server ignores anything else.
   */
  replace?: boolean;
}

/**
 * What a kubeconfig contains, as read by the server's own parser.
 *
 * Deliberately credential-free: `hasStaticToken` says whether the file carries a token,
 * `caPresent` whether it carries a CA. Neither value comes back. The page renders this as
 * its "detected" summary, so what it shows and what the server will act on cannot diverge.
 */
export interface KubeconfigDescription {
  apiUrl: string;
  contextName: string;
  contexts: string[];
  defaultNamespace: string | null;
  caPresent: boolean;
  credential: 'token' | 'exec-oidc' | 'exec' | 'auth-provider' | 'client-certificate' | 'none';
  hasStaticToken: boolean;
  oidcIssuer: string | null;
  /** The server's verdict, not the page's: does the operator still have to paste a token? */
  needsToken: boolean;
}

export interface OnboardStep {
  id: string;
  detail: string;
  level: 'ok' | 'warn';
}

export interface OnboardResult {
  cluster: Cluster;
  steps: OnboardStep[];
  expiresAt: string;
  kubernetesVersion: string | null;
  onboardedVia: 'token' | 'kubeconfig' | 'oidc';
  /**
   * False when a pasted token cannot mint its successor. The cluster is still onboarded —
   * it just goes dark at `expiresAt` unless the RBAC is fixed.
   */
  renewable: boolean;
  note: string;
}

// ------------------------------------------------------------------- envelopes

/** One cluster envelope, plus the flags that decide what the UI may offer for it. */
export type ClusterEnvelope = Envelope<Health> & Completeness & {
  removable?: boolean;
  source?: string;
  onboardedAt?: string | null;
  onboardedBy?: string | null;
};

export interface ClustersResponse {
  clusters: ClusterEnvelope[];
  /** The fleet-wide union of the completeness lists. Absent on an older server. */
  summary?: Completeness;
  canOnboard: boolean;
  /**
   * Whether this deployment and this account may de-register a cluster at all. Pairs with
   * `removable` on each row, which says whether that particular record is deletable rather than
   * baked into the image. Absent on an older server, where the control stays hidden.
   */
  canRemove?: boolean;
  collectedAt: string;
}

/** Everything one cluster's detail page needs, in one request. */
/**
 * The namespace-compliance rollup, straight off `srv/fleet/collectors/compliance.js`.
 *
 * `audited` is the denominator and it is **not** the namespace count: `systemSkipped` says how
 * many namespaces were deliberately left out of the audit. Showing `compliant` without both is
 * how "3 compliant" gets read as "the whole cluster", when the cluster had nine namespaces.
 */
export interface ComplianceRollup {
  audited: number;
  compliant: number;
  withWarnings: number;
  withFindings: number;
  /** System namespaces excluded from the audit by design — not failures, and not oversights. */
  systemSkipped: number;
  /**
   * Why `pods` is null on every row, or null when it is not. Kept out of `unavailable` on
   * purpose: those labels describe the bootstrap audit, and a refused pod list says nothing
   * about whether the audit itself was complete.
   */
  podCountReason?: 'unavailable' | 'truncated' | null;
}

export interface ClusterOverview {
  health: Health;
  compliance: { summary?: ComplianceRollup & Completeness; namespaces: NamespaceRow[] };
  workloads: Workloads;
  events: EventRow[];
}

/** The state of the renewal clock, which now runs inside the srv pod. */
export interface RenewerState {
  inProcess: boolean;
  /** The configured sweep cadence, so the UI never has to hardcode a default it may not have. */
  sweepIntervalMs?: number | null;
  at: string | null;
  healthy: number | null;
  total: number | null;
  renewed: number;
  error: string | null;
}

export interface TokensResponse {
  renewIntervalHours: number;
  tokenLifetimeHours: number;
  canRenew: boolean;
  /**
   * Whether *this deployment and this account* may de-register a cluster at all — the writers
   * exist and the caller carries the admin scope. `removable` on the row is the other half:
   * whether that particular cluster's record is deletable rather than baked into the image.
   */
  canRemove: boolean;
  renewer: RenewerState;
  clusters: ({ cluster: Cluster; removable?: boolean } & TokenHealth)[];
  checkedAt: string;
}

export interface Me {
  id: string;
  name?: string;
  email?: string;
  scopes?: string[];
  capabilities: { onboard: boolean; renew: boolean };
  /**
   * The exact redirect URI the SSO flow will send to the identity provider.
   *
   * Reported by the server rather than assembled here, because the browser's own origin is not
   * it — behind the vite proxy and behind the approuter the request reaches `srv` with a
   * different host, and the whole value of this string is that it matches character for
   * character what the issuer receives. Providers match it exactly; a trailing slash is refused.
   */
  ssoCallbackUrl?: string;

  /**
   * True when `ssoCallbackUrl` came from `FLEET_SSO_CALLBACK_URL`, false when the server had to
   * derive it from the request.
   *
   * A derived value is right for local development and wrong behind the approuter, which strips
   * `Host` — there it yields the cluster-internal service address. The console says which it is
   * looking at rather than printing a guess as an instruction.
   */
  ssoCallbackUrlConfigured?: boolean;

  /**
   * True when the callback URI is `https`, or `http` on loopback — the one exception OAuth
   * providers carve out and the shape `npm run fleet:dev` actually uses.
   *
   * False means a plain-http public callback, which most providers refuse to register and which
   * exposes the authorization code in transit where they do not. Worth saying before an
   * administrator spends a change window on it, not after.
   */
  ssoCallbackUrlSecure?: boolean;

  /**
   * Why the callback URI is not a configured https fact, or null when it is.
   *
   * `DERIVED_FROM_REQUEST` — the env var is unset. `CONFIGURED_VALUE_INVALID` — it is set to
   * something that is not an absolute http(s) URL, so it was ignored. `CONFIGURED_VALUE_INSECURE`
   * — it is set, and it is plain http on a public host. Three different fixes, so the console
   * names the one that applies instead of printing one warning over all three.
   */
  ssoCallbackUrlProblem?: 'DERIVED_FROM_REQUEST' | 'CONFIGURED_VALUE_INVALID' | 'CONFIGURED_VALUE_INSECURE' | null;
}

/**
 * Mounted under Vite's `base` (VITE_BASE_PATH at build time), so the same bundle works at `/`
 * in dev and under the app's URL prefix behind the SSO proxy. BASE_URL always ends in a slash.
 */
const BASE = `${import.meta.env.BASE_URL}api/fleet`;

/** Absolute-path URL of a fleet API endpoint, for navigations that bypass `fetch` (downloads). */
export function fleetApiUrl(path: string): string {
  return `${BASE}${path}`;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ------------------------------------------------------- lapsed SSO session

/**
 * A lapsed SSO session does not answer 401. It answers the IdP login bootstrap as
 * **HTML at HTTP 200**, same-origin, not redirected — so neither the redirect check nor a
 * status check sees it, and the operator gets told the upstream returned garbage when in
 * fact they simply need to sign in again.
 *
 * The only cure is a full page reload, which lets the SSO proxy re-run sign-in. The danger is a
 * console that reloads itself out from under the operator during the incident they opened it
 * for, so the budget for automatic reloads is a **wall clock** held in `sessionStorage`: the
 * timestamp of the last automatic reload is written immediately *before* `location.reload()`,
 * and no second automatic reload happens until `RELOAD_COOLDOWN_MS` has passed.
 *
 * A wall clock rather than a per-load counter, because a counter cannot be made to hold here.
 * `App.tsx` calls `api.me()` on every page load and the shell polls `api.clusters()` every
 * 30s, so at least one request succeeds on every load — anything a success is allowed to
 * reset is re-armed forever. That is precisely how the first version of this guard failed:
 * with `/me` answering JSON and one other endpoint answering HTML, the console reloaded
 * without end. A success must therefore never give the reload budget back.
 */
const SESSION_RELOAD_SENTINEL = 'fleet.session-reload-attempted';

/**
 * Ten minutes.
 *
 * The floor has to dominate everything that retries on its own — the 10s log tail on the Logs
 * page and the 30s `api.clusters()` poll in the shell — so a lapse that a reload cannot cure
 * costs one reload rather than one every ten seconds. It also sits under the approuter's
 * 15-minute default idle session timeout, which means two *genuine* lapses can never land
 * inside one window: a session that has just been re-established has to outlive that timeout
 * before it can lapse again, so the floor never blocks a legitimate self-heal. A second lapse
 * an hour later is far outside the window and still recovers with no operator action.
 */
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

export const SESSION_LOST = 'SESSION_LOST';

const SESSION_LOST_MESSAGE =
  'Session could not be re-established — sign in again. An automatic reload did not restore ' +
  'single sign-on, so it will not be retried automatically for the next few minutes. Reload ' +
  'the page yourself when you are ready to lose what is on screen, or open the dashboard URL ' +
  'in a new tab, sign in there, and come back.';

/**
 * When the last automatic reload was issued, or null if none was.
 *
 * sessionStorage throws in a sandboxed frame and in some privacy modes; never let that
 * escape. A stored value that will not parse is treated as "just now" and rewritten with a
 * real timestamp, so a corrupt sentinel costs one cooldown rather than wedging the tab.
 */
function readReloadAt(now: number): number | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(SESSION_RELOAD_SENTINEL);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const at = Number(raw);
  if (!Number.isFinite(at)) {
    writeReloadAt(now);
    return now;
  }
  return at;
}

function writeReloadAt(now: number): boolean {
  try {
    window.sessionStorage.setItem(SESSION_RELOAD_SENTINEL, String(now));
    return true;
  } catch {
    return false;
  }
}

function clearReloadAt(): void {
  try {
    window.sessionStorage.removeItem(SESSION_RELOAD_SENTINEL);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

/** Has this page load already issued a reload? Keeps concurrent requests from stacking reloads. */
let reloadIssuedThisLoad = false;

/**
 * The statuses at which an HTML body can honestly be the approuter's SSO bootstrap.
 *
 * A lapsed session serves the IdP login page as HTML at **200** — the redirect chain is
 * followed inside `fetch`, so 200 is the status this code sees. A 3xx only surfaces here if
 * the redirect was not followed, and an unfollowed redirect off an `/api/fleet` path is an
 * auth redirect.
 *
 * HTML at any other status came from the backend, not from in front of it. srv's own Express
 * finalhandler emits `text/html` for a 404 on an unknown `/api/fleet` path, and for the 413
 * that `express.json({ limit: '512kb' })` raises on an oversized kubeconfig — that parser is
 * a *sibling* of the fleet router in `srv/server.js`, so its `next(err)` skips the router's
 * JSON error handler entirely and lands on finalhandler. Both are real errors whose status
 * the operator has to see. Reloading the page over them throws away what they typed and
 * tells them nothing.
 */
function htmlCanCarryLoginPage(status: number): boolean {
  return status === 200 || (status >= 300 && status < 400);
}

function looksLikeLoginPage(res: Response, text: string): boolean {
  if (!htmlCanCarryLoginPage(res.status)) return false;
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return true;
  const head = text.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

/**
 * Turn a lapsed session into at most one automatic reload per cooldown window, and otherwise
 * into a terminal error the operator can act on. Returns the error to throw so the caller's
 * control flow stays obvious at the call site.
 */
function sessionLapsed(status: number): ApiError {
  // This load already fired its reload and the page is on its way out. Everything still in
  // flight gets the transient error rather than a terminal one it has no time to act on.
  if (reloadIssuedThisLoad) return new ApiError('re-authenticating', 'SESSION_EXPIRED', 401);

  const now = Date.now();
  const lastReloadAt = readReloadAt(now);
  if (lastReloadAt !== null && now - lastReloadAt < RELOAD_COOLDOWN_MS) {
    const waitMin = Math.max(1, Math.ceil((RELOAD_COOLDOWN_MS - (now - lastReloadAt)) / 60_000));
    logger.error(
      `Session still lapsed after an automatic reload (${status}); not reloading again for ${waitMin} min`
    );
    return new ApiError(SESSION_LOST_MESSAGE, SESSION_LOST, 401);
  }

  // No sentinel means no loop protection, so the reload is not safe to make. Surface the
  // terminal error instead of risking a lockout the operator cannot escape.
  if (!writeReloadAt(now)) {
    logger.error('Session lapsed but sessionStorage is unavailable; refusing an unguarded reload');
    return new ApiError(SESSION_LOST_MESSAGE, SESSION_LOST, 401);
  }

  reloadIssuedThisLoad = true;
  logger.warn(`Session lapsed (${status}); reloading once to re-run single sign-on`);
  window.location.reload();

  return new ApiError('re-authenticating', 'SESSION_EXPIRED', 401);
}

/**
 * A parsed JSON body proves the approuter let us reach srv.
 *
 * It clears the per-load flag only, and deliberately leaves the persisted reload timestamp
 * alone: `api.me()` succeeds on every page load, so a success that gave the reload budget
 * back would give it back forever. Clearing the per-load flag matters for the case where
 * `location.reload()` did not actually navigate — without it the flag would stay set and
 * every later lapse would return the transient error, so the operator would never be shown
 * the terminal message that tells them what to do.
 */
function noteSessionAlive(): void {
  reloadIssuedThisLoad = false;
}

/** True for the terminal session error, so a page can offer `retryAuthentication` instead of a code. */
export function isSessionLost(err: unknown): boolean {
  return err instanceof ApiError && err.code === SESSION_LOST;
}

/**
 * The manual retry behind that terminal error, and the reason the cooldown is safe to make
 * long: the operator is never made to wait it out. Clearing the timestamp first is what makes
 * this a retry rather than a no-op — the reload is allowed to attempt SSO once more, and the
 * window starts again from whatever that reload finds.
 */
export function retryAuthentication(): void {
  clearReloadAt();
  reloadIssuedThisLoad = false;
  window.location.reload();
}

/**
 * A non-JSON body that is not the login page came from srv, or from the ingress in front of
 * it. Its status is the only thing that says what went wrong, so it goes into the message:
 * `unexpected non-JSON response` on its own is not something an operator can act on, and the
 * 413 in particular is reachable by hand from the Onboard page.
 */
function nonJsonError(status: number, method: string, path: string): ApiError {
  if (status === 413) {
    return new ApiError(
      'Request body is larger than the 512 KiB the fleet API accepts (413). Paste a kubeconfig ' +
        'trimmed to the one context this cluster needs, or onboard with the token, API URL and ' +
        'CA fields instead of a full kubeconfig. Nothing was sent to the cluster.',
      'TOO_LARGE',
      status
    );
  }
  if (status === 404) {
    return new ApiError(
      `The fleet API has no ${path} endpoint (404). The console and the srv pod are most likely ` +
        'from different builds; redeploy srv, or check the ingress route for /api/fleet.',
      'NOT_FOUND',
      status
    );
  }
  if (status >= 500) {
    return new ApiError(
      `The fleet API failed without returning JSON (${status}). Check the srv pod logs for ` +
        `${method} ${path}.`,
      'UPSTREAM',
      status
    );
  }
  return new ApiError(`unexpected non-JSON response (${status})`, 'UPSTREAM', status);
}

/**
 * In-flight GET coalescing.
 *
 * Two components asking for the same URL in the same tick is not hypothetical here: two
 * independent sections of one tab can each `useAsync` the same per-cluster read, so one screen
 * issued two 80 KB requests. Speculative prefetch makes the collision the normal
 * case rather than the accident — the operator clicks a tab whose read is already on the wire.
 *
 * What is shared is the *promise*, never the response. Nothing is stored once the request
 * settles, so this cannot serve stale data and raises none of a cache's staleness questions —
 * it only says that two callers who asked the same question at the same moment can get one
 * answer.
 *
 * That "can" is not unconditional. A foreground click that lands on a *low-priority* read
 * already in flight does not join it: joining would inherit the low-priority header the
 * prefetcher sent, which the server's per-cluster gate (`withLowPriority` in router.js) queues
 * behind every other read on that cluster — measured at 1014ms against a 12ms cold read, because
 * the click waited out someone else's speculative sweep. So a foreground caller that finds a low
 * entry starts its own foreground-priority read and takes over the slot; the superseded low read
 * still runs to completion (nothing cancels it) but its `.finally` no longer owns the map entry,
 * so it cannot clear the new owner's slot out from under it. A low caller arriving while a
 * foreground read is in flight still joins it, and a foreground caller finding a foreground
 * entry still joins it too — both exactly as before.
 *
 * The cost of the upgrade path is one duplicate HTTP round trip, not one duplicate collection:
 * every route here reads through `cached()` in router.js, whose `Cache.wrap` (fanout.js) keys
 * its own `_inflight` map by the same cache key and joins a second `wrap()` call to the
 * collection already running. The upgraded request still queues at the express-level priority
 * gate as a foreground read, but the expensive part underneath — the collector's own fan-out —
 * runs once.
 */
type Priority = 'low' | undefined;

interface InflightEntry<T> {
  promise: Promise<T>;
  priority: Priority;
}

const inflightGets = new Map<string, InflightEntry<unknown>>();

/**
 * Whether a caller asking at `callerPriority` may join an entry already running at
 * `entryPriority`, or must start its own read and take over the slot.
 *
 * The one case that refuses to join: a foreground caller (`undefined`) finding a `low` entry.
 * Every other pairing joins — a low caller joining a foreground read, or either priority
 * joining its own kind — because none of those inherit a demotion the caller never asked for.
 */
export function shouldJoinInflight(entryPriority: Priority, callerPriority: Priority): boolean {
  return !(callerPriority === undefined && entryPriority === 'low');
}

/**
 * Join the in-flight read for `path` if joining would not inherit a demotion, or start one.
 */
function sharedGet<T>(path: string, priority?: 'low'): Promise<T> {
  const shared = inflightGets.get(path);
  if (shared && shouldJoinInflight(shared.priority, priority)) return shared.promise as Promise<T>;
  const fresh = send<T>(path, priority === 'low' ? { headers: { 'x-fleet-priority': 'low' } } : undefined)
    .finally(() => {
      // Delete only if we are still the registered entry. A caller that started a new read
      // after this one settled — or that upgraded past it while it was still running — owns the
      // slot now, and clearing it would orphan their group.
      if (inflightGets.get(path)?.promise === fresh) inflightGets.delete(path);
    });
  inflightGets.set(path, { promise: fresh, priority });
  return fresh;
}

/**
 * Warm a read the operator has not asked for yet. Never throws and never returns a value —
 * the only thing it leaves behind is a server-side cache entry the real request will hit.
 */
export function prefetchGet(path: string): Promise<void> {
  return sharedGet(path, 'low').then(
    () => undefined,
    () => undefined
  );
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  // Anything carrying an `init` — a method, a body, an `AbortSignal` — is passed straight
  // through. Sharing a promise whose underlying request another caller can abort would cancel
  // a read its owner never cancelled.
  return init ? send<T>(path, init) : sharedGet<T>(path);
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  const startTime = Date.now();
  const url = path.startsWith('/api/')
    ? `${import.meta.env.BASE_URL}${path.slice(1)}`
    : `${BASE}${path}`;

  const doFetch = async () =>
    fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {})
      }
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch (netErr) {
    logger.error(`Network fetch failed: ${method} ${path}`, netErr);
    throw netErr;
  }

  // The SSO proxy answers an expired session with a redirect to the IdP. Following it
  // inside fetch yields an opaque HTML login page rather than JSON, so it is detected
  // here and turned into a full page reload — the only thing that can re-authenticate.
  if (res.redirected && !res.url.startsWith(window.location.origin)) {
    throw sessionLapsed(res.status);
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A body that is not JSON came either from in front of srv or from srv failing before it
    // reached its own JSON error handler. HTML at 200 is the approuter's login bootstrap and
    // means the session lapsed; an opaque 401/403 means the same thing. HTML at any other
    // status is a backend error, and the operator has to be shown it with its status rather
    // than have the page reload underneath them.
    if (looksLikeLoginPage(res, text) || res.status === 401 || res.status === 403) {
      throw sessionLapsed(res.status);
    }
    logger.error(`Non-JSON response for ${method} ${path} (${res.status})`, text.slice(0, 200));
    throw nonJsonError(res.status, method, path);
  }

  // Reaching parseable JSON means the request went all the way to srv, whatever its status
  // says. That clears the per-load reload flag; the cooldown window keeps running.
  if (text) noteSessionAlive();

  const duration = Date.now() - startTime;
  logger.api(method, path, duration, res.status);

  if (!res.ok) {
    const e = body as { code?: string; message?: string } | null;
    const err = new ApiError(e?.message || `request failed (${res.status})`, e?.code || 'ERROR', res.status);
    logger.error(`API error ${method} ${path} -> [${res.status}] ${e?.code || 'ERROR'}: ${e?.message || ''}`);
    throw err;
  }
  return body as T;
}

function qs(params: Record<string, string | number | boolean | readonly string[] | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    // An array is serialised as REPEATED keys rather than one comma-joined value, because that
    // is the form Express hands a route handler as an array without a bespoke split — see
    // `normaliseNamespaces` in srv/fleet/k8s.js, which accepts both but canonicalises on this.
    if (Array.isArray(v)) {
      for (const one of v) if (one !== '') out.append(k, String(one));
      continue;
    }
    if (v !== undefined && v !== '') out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/**
 * A namespace selection, however a caller holds it, as the sorted deduped array the URL wants.
 *
 * Sorted HERE and not only on the server: the server normalises for its own cache key, but the
 * browser's URL is a cache key too — `prefetch` warms a read by URL and the click has to make
 * the byte-identical request or the speculative fetch buys nothing and costs a second one.
 */
function namespaceParam(
  ns: string | readonly string[] | ReadonlySet<string> | undefined
): readonly string[] | undefined {
  if (ns === undefined) return undefined;
  const names = typeof ns === 'string' ? [ns] : [...ns];
  const unique = [...new Set(names.map(n => n.trim()).filter(Boolean))].sort();
  return unique.length ? unique : undefined;
}

/**
 * Lines of Envoy access log read per proxy, when nobody has chosen otherwise.
 *
 * Exported and used by both the Traffic tab's control and `clusterTrafficErrors` itself, so
 * the URL the prefetch warms and the URL the tab requests cannot drift apart. They did: the
 * prefetch asked for `/traffic-errors` and the tab for `/traffic-errors?tailLines=300`, which
 * are two cache keys, so the speculative read bought nothing and cost a second ten-pod log
 * sweep. One constant is the only version of this that stays fixed.
 */
export const DEFAULT_TRAFFIC_TAIL = 300;

/**
 * The Distributed Traces tab's default tail, for the same reason as `DEFAULT_TRAFFIC_TAIL`: the tab
 * and the prefetch both build their URL from it. They drifted the same way (`/traces` warmed,
 * `/traces?tailLines=500` read), found 2026-09-27. `DEFAULT_TAIL_LINES` in
 * `srv/fleet/collectors/traces.js` is the server's matching default.
 */
export const DEFAULT_TRACES_TAIL = 500;

/**
 * The URL of one release's related-resource read.
 *
 * Exported for the same reason as `DEFAULT_TRAFFIC_TAIL` above: the Helm tab warms this path
 * when the pointer settles on a release row, and the release page then requests it. If the two
 * are built in two places they eventually differ by an encoding or a slash, and a warm that
 * misses is worse than no warm at all — it pays the cost twice.
 */
export const helmRelatedPath = (id: string, namespace: string, name: string): string =>
  `/clusters/${id}/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/related`;

/**
 * One live object as YAML, with the server's account of what it took out.
 *
 * `redactions` is a list of sentences, not codes — it goes straight on screen. It is empty for
 * most objects and that emptiness is meaningful: the drawer only prints the notice when something
 * was actually removed, so a reader learns to believe it.
 */
export interface ResourceYamlData {
  kind: string;
  name: string;
  namespace: string | null;
  apiVersion: string | null;
  resourceVersion: string | null;
  /** The redacted object, serialised. Never contains a Secret value, a ConfigMap value or an
   *  inline container env value — see `srv/fleet/collectors/resource-yaml.js`. */
  yaml: string;
  redactions: string[];
}

export const api = {
  clusters: () => get<ClustersResponse>('/clusters'),
  cluster: (id: string) => get<ClusterEnvelope>(`/clusters/${id}`),
  overview: (id: string) => get<Envelope<ClusterOverview>>(`/clusters/${id}/overview`),
  namespaces: (id: string) =>
    get<Envelope<{ summary?: ComplianceRollup & Completeness; namespaces: NamespaceRow[] }>>(
      `/clusters/${id}/namespaces`
    ),
  /**
   * Workloads for one cluster, optionally narrowed to a set of namespaces. Several namespaces
   * are sent as repeated `?namespace=` keys and OR'd server-side, where each one is read at the
   * source rather than filtered out of a cluster-wide read.
   *
   * Where server-side namespace filtering is and is not the right answer, since the read-only
   * standard asks for it "for large clusters":
   *
   *  - **Namespaces & Workloads does not use this route.** That page reads `/clusters/:id/overview`,
   *    which carries health, compliance, workloads and events in one response because its tiles
   *    and counts are cluster-wide by definition. Its namespace filter is therefore client-side,
   *    over data the page already holds. Moving that filter to the server would not shrink the
   *    browser's payload — the overview read still has to happen for the tiles above the table —
   *    it would add a second request for a subset of what just arrived.
   *  - **A namespace-scoped view is where this route belongs**: one whose entire dataset *is*
   *    the filtered set, with no cluster-wide aggregate above it. Then the filtered read is the
   *    only read, and N namespaces cost N namespaced list calls instead of the whole cluster.
   *  - **Truncation is what makes it correctness rather than performance.** `k8s.list` stops at
   *    its item ceiling and marks the result truncated; past that ceiling a cluster-wide list is
   *    partial, and filtering a partial list in the browser hides rows that were never sent
   *    while showing a confident count. A namespaced read of the selection is complete, and says
   *    so through `summary.unavailable` / `summary.truncated`.
   */
  workloads: (id: string, ns?: string | readonly string[] | ReadonlySet<string>) =>
    get<Envelope<Workloads>>(`/clusters/${id}/workloads${qs({ namespace: namespaceParam(ns) })}`),
  fleetWorkloads: () => get<FleetWorkloads>('/workloads'),
  events: (id: string, ns?: string) =>
    get<Envelope<EventRow[]>>(`/clusters/${id}/events${qs({ namespace: ns })}`),
  compliance: () => get<ComplianceReport>('/compliance'),
  networking: () => get<FleetNetworking>('/networking'),
  storage: () => get<FleetStorage>('/storage'),
  security: () => get<FleetSecurity>('/security'),

  // The per-cluster halves of the three routes above. These existed server-side long before
  // they had a client method, which is why the cluster tabs were fetching the whole fleet and
  // filtering in the browser — one cluster's read costs less, lands on the same `cache.wrap`
  // key the Overview tile already primed, and is the *only* place the per-cluster summary
  // fields live: the fleet-wide routes re-derive their summaries and drop
  // `defaultStorageClassState`, `quotaCoverage` and `limitRanges` on the floor.
  clusterNetworking: (id: string, ns?: string) =>
    get<ClusterNetworking>(`/clusters/${id}/networking${qs({ namespace: ns })}`),
  clusterStorage: (id: string, ns?: string) =>
    get<ClusterStorage>(`/clusters/${id}/storage${qs({ namespace: ns })}`),
  clusterSecurity: (id: string) => get<ClusterSecurity>(`/clusters/${id}/security`),

  tokens: () => get<TokensResponse>('/tokens'),
  me: () => get<Me>('/me'),
  status: () => get<AppStatusResponse>('/api/status'),

  renew: (id: string) => {
    logger.action(`Renewing token for cluster '${id}'`);
    return get<{ cluster: string; expiresAt: string }>(`/tokens/${id}/renew`, { method: 'POST' });
  },

  // --- logs
  pods: (id: string, ns?: string) => get<Envelope<PodInventory>>(`/clusters/${id}/pods${qs({ namespace: ns })}`),
  logs: (id: string, q: LogQuery) => get<LogTail>(`/clusters/${id}/logs${qs({ ...q })}`),

  /**
   * Rollout status — a GET, and the only rollout-related call this client makes.
   *
   * `restart` and `scale` used to sit on either side of it and are deliberately gone: this dashboard
   * is a strictly read-only platform and must never change cluster state. Re-adding either one
   * is a product decision, not a refactor.
   */
  rollout: (id: string, namespace: string, name: string, kind: string) =>
    get<RolloutStatus>(
      `/clusters/${id}/workloads/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/rollout${qs({ kind })}`
    ),
  // --- new enterprise collectors
  autoscaling: () => get<FleetAutoscaling>('/autoscaling'),
  clusterAutoscaling: (id: string) => get<ClusterAutoscaling>(`/clusters/${id}/autoscaling`),
  certificates: () => get<FleetCertificates>('/certificates'),
  clusterCertificates: (id: string) => get<ClusterCertificates>(`/clusters/${id}/certificates`),
  topology: () => get<FleetTopology>('/topology'),
  clusterTopology: (id: string) => get<ClusterTopology>(`/clusters/${id}/topology`),
  drift: () => get<FleetDrift>('/drift'),

  // --- new enterprise collectors, wave 2
  mesh: () => get<FleetGroup<MeshData>>('/mesh'),
  clusterMesh: (id: string) => get<ClusterGroupEnvelope<MeshData>>(`/clusters/${id}/mesh`),
  /**
   * Modelled spend for one cluster. Its own request: nothing else on the console needs a rate
   * card, and this is the only collector whose numbers are not read from the cluster.
   */
  clusterCost: (id: string) => get<ClusterCostResponse>(`/clusters/${id}/cost`),
  capacity: () => get<FleetGroup<CapacityData>>('/capacity'),
  clusterCapacity: (id: string) => get<ClusterGroupEnvelope<CapacityData>>(`/clusters/${id}/capacity`),
  reliability: () => get<FleetGroup<ReliabilityData>>('/reliability'),
  clusterReliability: (id: string) => get<ClusterGroupEnvelope<ReliabilityData>>(`/clusters/${id}/reliability`),
  observability: () => get<FleetGroup<ObservabilityData>>('/observability'),
  clusterObservability: (id: string) => get<ClusterGroupEnvelope<ObservabilityData>>(`/clusters/${id}/observability`),
  clusterHelmReleases: (id: string) => get<ClusterGroupEnvelope<HelmData>>(`/clusters/${id}/helm/releases`),
  /**
   * One live object as redacted YAML — what a detail drawer opens.
   *
   * Lazy on purpose: nothing calls it until an operator clicks a resource. Folding the objects
   * into `/related` would turn a 73 kB release payload into a multi-megabyte one to serve the
   * single object they eventually open, and would pay that on every release page load.
   *
   * What comes back is the **live** object, not what Helm rendered — the two differ the moment a
   * webhook, a controller default or a `kubectl edit` touches it, which is exactly why this view
   * is worth opening. `redactions` lists what the server removed; the drawer prints it, because a
   * blank field a reader takes for the configured value is its own wrong answer.
   */
  clusterResourceYaml: (id: string, kind: string, namespace: string | null, name: string) =>
    get<ClusterGroupEnvelope<ResourceYamlData>>(
      `/clusters/${id}/resource-yaml${qs({ kind, namespace: namespace ?? undefined, name })}`
    ),
  /**
   * HTTP 4xx/5xx read from Envoy access logs on `istio-proxy`, with each failure attributed to a
   * route, an upstream Service and the Pod behind it.
   *
   * Cluster-only by design. It reads up to ten pod logs per call, so there is no fleet-wide
   * form — fanning it across the registry would turn one page view into a hundred log streams.
   * `namespace` narrows which proxies are read; `tailLines` and `maxPods` are clamped
   * server-side, so neither can widen the read beyond its ceiling.
   *
   * `fresh` is the tab's Refresh control, and only the Refresh control. A log tail is a moving
   * window, so the server keeps its answer for a few seconds — enough that opening the tab is
   * instant instead of a 5-7s wait for ten pod logs — and an operator who asks for the current
   * tail after a deploy gets the proxies read again rather than that copy. Automatic reads
   * (mount, prefetch, a remount from a tab switch) deliberately do not set it: they are not a
   * person asking "what is happening *now*".
   *
   * `tailLines` defaults to `DEFAULT_TRAFFIC_TAIL` **here**, rather than being left to the
   * caller. It used to be the tab's `useState(300)` alone, and the prefetch — which passes no
   * options — therefore warmed `/traffic-errors` while the tab requested
   * `/traffic-errors?tailLines=300`. Different URL, different cache key on both sides, so the
   * prefetch was not merely useless: it paid the full ten-pod log read a second time. Measured
   * in the browser, the pair cost 8.6s and 2.3s back to back for one tab open.
   */
  /**
   * Distributed traces for one cluster: the same access-log window the Traffic tab reads, stitched
   * into journeys instead of grouped into failures.
   *
   * `fresh` sends `cache-control: no-cache`, which the tab's Refresh control uses and nothing else
   * does — the server caches this for seconds so a tab switch does not re-tail twelve pod logs.
   */
  clusterTraces: (
    id: string,
    q: { namespace?: string; polls?: 'show'; tailLines?: number; maxPods?: number; sinceSeconds?: number } = {},
    opts: { fresh?: boolean } = {}
  ) =>
    get<ClusterTracesResponse>(
      `/clusters/${id}/traces${qs({ ...q })}`,
      opts.fresh ? { headers: { 'cache-control': 'no-cache' } } : undefined
    ),
  /**
   * One trace out of that same window.
   *
   * Served from the list's cache entry on the server, so the drawer shows the window the row came
   * from. `notFoundReason: 'NOT_IN_WINDOW'` is the expected end of every trace's life here — a log
   * tail moves — and is not an error.
   */
  clusterTrace: (
    id: string,
    traceId: string,
    q: { namespace?: string; polls?: 'show'; tailLines?: number; maxPods?: number; sinceSeconds?: number } = {}
  ) => get<ClusterTracesResponse>(`/clusters/${id}/traces/${encodeURIComponent(traceId)}${qs({ ...q })}`),
  clusterTrafficErrors: (
    id: string,
    q: { namespace?: string; tailLines?: number; maxPods?: number; sinceSeconds?: number } = {},
    opts: { fresh?: boolean } = {}
  ) =>
    get<ClusterGroupEnvelope<TrafficData>>(
      `/clusters/${id}/traffic-errors${qs({ tailLines: DEFAULT_TRAFFIC_TAIL, ...q })}`,
      opts.fresh ? { headers: { 'cache-control': 'no-cache' } } : undefined
    ),
  /**
   * Everything live that this release touches: the rows, the typed relationship graph, the
   * namespace's events joined by `involvedObject`, and the rendered entries with no live object.
   *
   * One request for Insights, Resources, Architecture and Events rather than four, because they
   * are four views of one relationship resolution — splitting it would let the four screens
   * disagree about the same release. Lazy: nothing fetches it until a release page opens.
   */
  clusterHelmRelated: (id: string, namespace: string, name: string) =>
    get<ClusterGroupEnvelope<HelmRelatedData>>(helmRelatedPath(id, namespace, name)),
  /**
   * One release's rendered manifest and chart source. Separate from the list on purpose —
   * the manifests on a single cluster run to hundreds of kilobytes, so this is fetched only
   * when someone opens the Manifest view for one release.
   */
  clusterHelmManifest: (id: string, namespace: string, name: string, revision?: number) =>
    get<ClusterGroupEnvelope<HelmManifestData>>(
      `/clusters/${id}/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/manifest` +
        (revision === undefined ? '' : `?revision=${revision}`)
    ),
  workloadGraph: (id: string, namespace: string, kind: string, name: string) =>
    get<ClusterGroupEnvelope<WorkloadGraph>>(
      `/clusters/${id}/workloads/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/graph`
    ),

  // --- fleet-wide group state plus the per-cluster breakdown, one call for every rail dot
  summary: () => get<FleetSummaryResponse>('/summary'),
  /** Per-cluster group state — one call for every tile on a cluster's Overview tab. */
  clusterSummary: (id: string) => get<ClusterSummaryResponse>(`/clusters/${id}/summary`),

  // --- onboarding
  /**
   * Read an uploaded or pasted kubeconfig and report what it contains. Registers nothing.
   *
   * The page shows the answer as its "detected" panel instead of parsing the YAML itself,
   * so the summary on screen is by construction the same reading the server will act on.
   */
  describeKubeconfig: (kubeconfig: string, contextName?: string) =>
    get<KubeconfigDescription>('/clusters/kubeconfig/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kubeconfig, contextName })
    }),
  onboard: (body: OnboardRequest) => {
    logger.action(`Onboarding cluster '${body.name}'`, { env: body.env, authMode: body.authMode });
    return get<OnboardResult>('/clusters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  },
  /**
   * De-register a cluster from the fleet.
   *
   * **Local only, and not a cluster mutation.** It deletes this dashboard's record of the
   * cluster and the token it holds for it. Nothing on the target cluster is touched — the
   * namespace, the `fleet-reader` account and its ClusterRole all remain, and the response
   * names the `kubectl` commands that would remove them. That is why this does not breach the
   * read-only invariant: forgetting a credential is not the same act as changing a cluster.
   *
   * Wired to exactly one control, on the cluster's own Credentials tab, behind a typed
   * confirmation. The Remove buttons that used to sit on the overview table and the detail
   * header are still gone on purpose — a one-click offboard next to a row of live clusters is
   * a mis-click away from blinding the fleet. Re-adding either of those is a product decision.
   */
  offboard: (id: string) => {
    logger.action(`Offboarding cluster '${id}'`);
    return get<{ cluster: string; removed: boolean; leftBehind: string }>(`/clusters/${encodeURIComponent(id)}/remove`, {
      method: 'POST'
    });
  },

  // --- OIDC/SSO onboarding, the two-step PKCE flow. `POST /clusters` is still the entry
  // point when the kubeconfig carries a static credential; this pair only fires when it
  // is an exec-OIDC kubeconfig with no static token to onboard with directly.
  bootstrapOidc: (body: OnboardRequest) => {
    logger.action(`Starting OIDC bootstrap for cluster '${body.name}'`, { env: body.env });
    return get<OidcBootstrapStart>('/clusters/bootstrap-oidc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
};

/**
 * One Gateway API Gateway (`gateway.networking.k8s.io/v1`). Both `/networking` and
 * `/clusters/:id/networking` run the same row builder in `server/fleet/collectors/networking.js`,
 * so one type serves both. `programmed` is the controller's own `Programmed` condition; `null`
 * means the controller has not reported one.
 */
export interface GatewayRow {
  id: string;
  clusterId?: string;
  name: string;
  namespace: string;
  gatewayClassName: string | null;
  listeners: { name: string | null; protocol: string | null; port: number | null; hostname: string | null; tls: boolean }[];
  programmed: boolean | null;
  createdAt: string | null;
}

/**
 * One Gateway API HTTPRoute. `parents` are `namespace/name` of the Gateways it attaches to, and a
 * backend with no namespace is the route's own — both already filled in by the collector.
 * `accepted` is true only when every parent accepted it; `null` when no parent has reported.
 */
export interface HttpRouteRow {
  id: string;
  clusterId?: string;
  name: string;
  namespace: string;
  hostnames: string[];
  parents: string[];
  backends: { name: string; namespace: string; port: number | null; weight: number }[];
  accepted: boolean | null;
  createdAt: string | null;
}

export interface VirtualServiceRow {
  id: string;
  clusterId?: string;
  name: string;
  namespace: string;
  hosts: string[];
  gateways: string[];
  routes: { destinationHost: string; destinationPort: number | null; weight: number }[];
  createdAt: string | null;
}

export interface IngressRow {
  id: string;
  clusterId?: string;
  name: string;
  namespace: string;
  rules: { host: string; paths: { path: string; pathType?: string; backendService: string }[] }[];
  tls: { hosts: string[]; secretName: string | null }[];
  ingressClassName: string | null;
  createdAt?: string | null;
}

export interface ServiceRow {
  name: string;
  clusterId?: string;
  namespace: string;
  type: string;
  clusterIP: string | null;
  ports: { name: string | null; port: number; targetPort: number | string; protocol: string }[];
}

export interface FleetNetworking {
  summary: {
    clusters: number;
    unreachable: number;
    totalHttpRoutes: number;
    totalGateways: number;
    totalVirtualServices: number;
    totalIngresses: number;
    totalServices: number;
  } & Completeness;
  clusters: ClusterSlot[];
  httproutes: HttpRouteRow[];
  gateways: GatewayRow[];
  virtualservices: VirtualServiceRow[];
  ingresses: IngressRow[];
  services: ServiceRow[];
  collectedAt?: string;
}

/**
 * One cluster's networking payload: Ingresses, Gateway API Gateways and HTTPRoutes, Istio
 * VirtualServices and Gateways, and Services. Gateway API and Istio are optional CRDs — a 404 on
 * either is an honest zero, never an entry in `summary.unavailable`.
 */
export interface NetworkingData {
  cluster: CollectorCluster;
  summary: {
    ingressesCount: number;
    /** Gateway API Gateways. Istio's own Gateway CR is `istioGatewaysCount`. */
    gatewaysCount: number;
    httproutesCount: number;
    virtualServicesCount: number;
    istioGatewaysCount: number;
    servicesCount: number;
  } & Completeness;
  ingresses: IngressRow[];
  gateways: GatewayRow[];
  httproutes: HttpRouteRow[];
  virtualservices: VirtualServiceRow[];
  services: ServiceRow[];
  collectedAt?: string;
}

export type ClusterNetworking = ClusterGroupEnvelope<NetworkingData>;

export interface PvcRow {
  name: string;
  clusterId?: string;
  namespace: string;
  status: string;
  storageClass: string;
  requested: string;
  requestedBytes?: number;
  capacity: string;
  accessModes: string[];
  volumeName: string | null;
  createdAt: string | null;
}

export interface QuotaRow {
  name: string;
  clusterId?: string;
  namespace: string;
  dimensions: { dimension: string; hard: string; used: string }[];
  createdAt?: string | null;
}

/** One LimitRange, with the per-type defaults an operator actually needs to see. */
export interface LimitRangeRow {
  name: string;
  namespace: string;
  limits: {
    type: string;
    default: Record<string, string> | null;
    defaultRequest: Record<string, string> | null;
    max: Record<string, string> | null;
    min: Record<string, string> | null;
  }[];
  createdAt: string | null;
}

/**
 * Whether a default StorageClass exists — and if not, whether that is a finding or an unread.
 *
 * A StorageClass has no conditions of its own, so `ready` here means only "the object we would
 * hand out exists and is unambiguous". `name` is an array in the `ambiguous` case, because the
 * useful fact is *which* classes are competing.
 */
export interface DefaultStorageClassState {
  state: 'ready' | 'missing' | 'ambiguous' | 'unavailable';
  name: string | string[] | null;
  detail: string | null;
}

export interface FleetStorage {
  summary: {
    totalPvcs: number;
    boundPvcs: number;
    pendingPvcs: number;
    totalRequestedBytes: number;
    totalQuotas: number;
  } & Completeness;
  clusters: ClusterSlot[];
  pvcs: PvcRow[];
  quotas: QuotaRow[];
  collectedAt?: string;
}

/**
 * One cluster's storage payload. The fleet-wide route flattens its summary to five totals and
 * drops `defaultStorageClassState`, `limitRangesCount`, `limitRanges` and `quotaCoverage`
 * entirely — which is why the StorageTab, sourced fleet-wide, could not show any of them.
 */
export interface StorageData {
  cluster: CollectorCluster;
  summary: {
    totalPvcs: number;
    boundPvcs: number;
    pendingPvcs: number;
    /** Sum over the PVCs that were returned. A floor, not a total, when `truncated` is set. */
    totalRequestedBytes: number;
    quotasCount: number;
    limitRangesCount: number;
    defaultStorageClassState: DefaultStorageClassState;
    /**
     * Fraction (0–1) of namespaces that have at least one ResourceQuota. **Null** when either
     * side of the ratio could not be read, or when the request was namespace-scoped — a
     * single namespace's "0 of 1" would otherwise masquerade as a cluster statistic. Render
     * null as unavailable, never as 0%.
     */
    quotaCoverage: number | null;
  } & Completeness;
  pvcs: PvcRow[];
  quotas: QuotaRow[];
  limitRanges: LimitRangeRow[];
  collectedAt?: string;
}

export type ClusterStorage = ClusterGroupEnvelope<StorageData>;

/**
 * The security posture numbers one cluster reports.
 *
 * Every count is the *scope of the audit*, not a fleet statistic: `appNamespacesAudited` and
 * `totalPodsAudited` are the denominators that make `networkPolicyIsolationScore` and
 * `nonRootContainers` mean anything, which is why they are worth a pixel of their own.
 *
 * `totalSecretsCount` and `secretTypeDistribution` are metadata only, and stronger than that
 * now: the server counts Secrets with a metadata-only list and per-type field selectors, so no
 * Secret body is read at all. There is no value to strip because none was ever fetched.
 */
export interface SecuritySummary {
  totalNamespaces: number;
  appNamespacesAudited: number;
  networkPolicyProtectedNamespaces: number;
  /**
   * The narrower, truer count: namespaces where *both* directions are covered by an all-pods
   * selector. `networkPolicyProtectedNamespaces` only says a NetworkPolicy exists, which is the
   * weaker claim, so the two are always shown together.
   *
   * Optional because a server older than this field returns the audit without it, and rendering
   * `0 isolated` from an absent field would be a fabricated verdict.
   */
  networkPolicyFullyIsolatedNamespaces?: number;
  /**
   * `null` — never 100 — when `appNamespacesAudited` is 0: there is no denominator, so there is no
   * ratio. Typed nullable so no consumer can interpolate it into a percent string and print
   * `null%`; use `networkPolicyIsolationScoreText` for that.
   */
  networkPolicyIsolationScore: number | null;
  /**
   * The ratio already rendered by the collector: `"57%"`, or
   * `"not applicable (no app namespaces)"`. Optional because a server predating the field omits it.
   */
  networkPolicyIsolationScoreText?: string;
  totalNetworkPolicies: number;
  totalPodsAudited: number;
  totalContainers: number;
  nonRootContainers: number;
  privilegedContainers: number;
  totalSecretsCount: number;
  totalServiceAccounts: number;
}

/**
 * How completely one direction is covered in a namespace. `partial` is the state the old
 * has-a-policy pill could not express: policies govern the direction, but every one of them is
 * pod-selective, so any pod outside those selectors is unrestricted.
 */
export type NetPolDirection = 'all' | 'partial' | 'none';

export interface NetworkPolicyByNamespace {
  namespace: string;
  hasNetworkPolicy: boolean;
  policyCount: number;
  /** Pods seen in this namespace. A floor when the pod read hit its paging ceiling. */
  podsObserved?: number;
  ingress?: NetPolDirection;
  egress?: NetPolDirection;
  /** Pods no NetworkPolicy in the namespace selects — the exceptions the policy count hides. */
  unselectedPods?: number;
}

export interface FleetSecurity {
  /** The union across the fleet. Absent on a server older than the completeness contract. */
  summary?: Completeness;
  clusters: (Completeness & {
    clusterId: string;
    displayName: string;
    env: string;
    summary: SecuritySummary & Completeness;
    networkPolicies: NetworkPolicyByNamespace[];
    secretTypeDistribution: Record<string, number>;
    secretTypeDistributionComplete?: boolean;
  })[];
  unreachable: { id: string; error?: FleetError }[];
  collectedAt?: string;
}

/** One container, identified and nothing more. The payload for the two posture lists. */
export interface ContainerRef {
  namespace: string;
  pod: string;
  container: string;
}

/** One cluster's security payload, from the route whose cache key the Overview tile shares. */
export interface SecurityData {
  cluster: CollectorCluster;
  summary: SecuritySummary & Completeness;
  networkPolicies: NetworkPolicyByNamespace[];
  secretTypeDistribution: Record<string, number>;
  /**
   * False when a type count was refused or hit the paging ceiling. The buckets present are
   * still exact; they just do not add up to `totalSecretsCount`, so the UI must not render the
   * breakdown as a whole. Optional because a server older than this field omits it.
   */
  secretTypeDistributionComplete?: boolean;
  /**
   * The containers behind `summary.privilegedContainers` and the non-root shortfall, by name.
   * Object names only — namespace, pod, container — because the classification already happened
   * server-side and nothing else about a container belongs on the wire.
   *
   * Capped at 200 each; `summary.truncated` names `containers[privileged]` /
   * `containers[root-capable]` when a list was cut short, and the counts stay the true totals.
   *
   * Optional, and absent means something different from empty: a server older than this field
   * does not report the lists at all, while `[]` is the real answer "there are none".
   */
  privilegedContainerList?: ContainerRef[];
  rootCapableContainerList?: ContainerRef[];
  collectedAt?: string;
}

export type ClusterSecurity = ClusterGroupEnvelope<SecurityData>;

/**
 * One entry of an HPA's `spec.metrics`, with the matching `status.currentMetrics` reading folded in.
 *
 * `type` is the display string the collector has always produced (`Resource (cpu)`); the fields under
 * it are the structured form, added because four of the five metric types are not `Resource` and an
 * `External` metric — what every KEDA scaler writes — carried no readable value at all.
 */
export interface HpaMetric {
  /** `Resource (cpu)`, `External (rabbitmq-queue-length)`. Display only; never parsed. */
  type: string;
  /** `target`/`current` as text, with `'—'` for absent. Kept for the resource drawer's flat fields. */
  target: string;
  current: string;
  /** Resource | ContainerResource | Pods | Object | External | Unknown. */
  kind: string;
  /** `cpu`, or the custom/external metric's name. `null` when the metric body was unparseable. */
  name: string | null;
  /** Only ContainerResource metrics are scoped to one container. */
  container: string | null;
  /** What an Object metric is measured against — `Ingress/bookshop`. `null` on every other type. */
  describedObject: { kind: string | null; name: string | null } | null;
  /** The nullable form of `target`/`current`: absent stays absent so it can be compared. */
  targetValue: string | null;
  currentValue: string | null;
}

export interface HpaRow {
  id: string;
  clusterId: string;
  name: string;
  namespace: string;
  targetKind: string;
  targetName: string;
  /**
   * All four are nullable, and each `null` means a different absence.
   *
   * `minReplicas` and `maxReplicas` come from the spec; `currentReplicas` and `desiredReplicas` come
   * from `status`, which is empty until the HPA controller has reconciled the object at least once.
   * A `null` here is therefore "not reported", and `0` is a genuine scaled-to-zero workload — KEDA
   * and HPAScaleToZero both produce one — so the two never render the same way.
   */
  minReplicas: number | null;
  maxReplicas: number | null;
  currentReplicas: number | null;
  desiredReplicas: number | null;
  metrics: HpaMetric[];
  conditions: { type: string; status: string; reason: string | null; message: string | null }[];
  lastScaleTime: string | null;
  createdAt: string | null;
}

export interface CronJobRow {
  id: string;
  clusterId: string;
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  activeJobsCount: number;
  lastScheduleTime: string | null;
  lastSuccessfulTime: string | null;
  /** Allow | Forbid | Replace — what happens when a run overlaps the previous one. */
  concurrencyPolicy: string;
  createdAt: string | null;
}

export interface FleetAutoscaling {
  summary: {
    clusters: number;
    unreachable: number;
    totalHpas: number;
    /**
     * Only the per-cluster collector publishes this; `GET /autoscaling` re-derives its own
     * summary and leaves it off. Optional, so a fleet-wide reader cannot silently read
     * `undefined` as a number.
     */
    scalingActive?: number;
    totalCronJobs: number;
    activeCronJobs: number;
  } & Completeness;
  clusters: ClusterSlot[];
  hpas: HpaRow[];
  cronjobs: CronJobRow[];
  collectedAt?: string;
}

/**
 * One cluster's autoscaling payload, as `srv/fleet/collectors/autoscaling.js` returns it.
 *
 * **Deliberately not `= FleetAutoscaling`.** The two shapes differ in both directions — the
 * fleet aggregate carries `clusters`/`unreachable` on its summary and omits `scalingActive`,
 * this one is the reverse — and `GET /clusters/:id/autoscaling` wraps the payload in the
 * fan-out envelope. The old alias claimed `hpas` sat at the top level of the response, so
 * `AutoscalingTab` read `data.hpas` off an envelope that has no `hpas`: the table rendered
 * "No HorizontalPodAutoscalers defined" on every cluster, forever, and the compiler agreed
 * with it. Envelope-shaped types are the only ones that make the nesting checkable.
 */
export interface AutoscalingData {
  cluster: Cluster;
  summary: {
    totalHpas: number;
    scalingActive: number;
    totalCronJobs: number;
    activeCronJobs: number;
  } & Completeness;
  hpas: HpaRow[];
  cronjobs: CronJobRow[];
}

export type ClusterAutoscaling = ClusterGroupEnvelope<AutoscalingData>;

export interface CertificateRow {
  id: string;
  clusterId: string;
  name: string;
  namespace: string;
  dnsNames: string[];
  secretName: string;
  issuerRef: string;
  notAfter: string | null;
  daysRemaining: number | null;
  isReady: boolean;
  isExpiringSoon: boolean;
  isExpired: boolean;
  renewalTime: string | null;
}

export interface IngressTlsRow {
  ingressName: string;
  namespace: string;
  hosts: string[];
  secretName: string;
}

export interface FleetCertificates {
  summary: {
    clusters: number;
    unreachable: number;
    totalCertificates: number;
    expiringSoon: number;
    expired: number;
    unready: number;
  } & Completeness;
  clusters: ClusterSlot[];
  certificates: CertificateRow[];
  ingressTls: IngressTlsRow[];
  collectedAt?: string;
}

/**
 * One cluster's certificate payload, as `srv/fleet/collectors/certificates.js` returns it.
 *
 * Not `= FleetCertificates`, for the same reason `AutoscalingData` is not `= FleetAutoscaling`:
 * `GET /clusters/:id/certificates` returns the fan-out envelope, and only the per-cluster
 * collector publishes `providers` and `totalIngressTlsHosts`. The old alias put
 * `certificates` at the top level, so `CertificatesSection` read `data.certificates` off an
 * envelope and rendered an empty table on every cluster.
 */
export interface CertificatesData {
  cluster: Cluster;
  summary: {
    totalCertificates: number;
    expiringSoon: number;
    expired: number;
    unready: number;
    /** The CRD groups actually served here — which is what makes 0 certificates readable. */
    providers: string[];
    /** Hostnames covered by an Ingress `tls:` block, counted with duplicates. */
    totalIngressTlsHosts: number;
  } & Completeness;
  certificates: CertificateRow[];
  ingressTls: IngressTlsRow[];
}

export type ClusterCertificates = ClusterGroupEnvelope<CertificatesData>;

export interface TopologyNode {
  name: string;
  clusterId?: string;
  nodeGroup?: string;
  zone: string;
  region: string;
  instanceType: string;
  isReady: boolean;
  kubeletVersion: string;
  osImage: string;
  containerRuntime: string;
  architecture: string;
  capacity: { cpu: string; memory: string; pods: string };
  podsScheduled?: number;
  podCapacity?: number;
  podUsagePercent?: number | null;
  cpuAllocatable?: number;
  cpuCapacity?: number;
  cpuRequested?: number;
  cpuRequestedPercent?: number | null;
  memoryAllocatable?: number;
  memoryCapacity?: number;
  memoryRequested?: number;
  memoryRequestedPercent?: number | null;
  podsList?: {
    name: string;
    namespace: string;
    phase: string;
    restarts?: number;
    cpuRequested?: number;
    memoryRequested?: number;
  }[];
}

/**
 * One taint a node declares, plus the two pod counts that must never be conflated.
 *
 * `podsTolerating` is permission — how many pods hold a toleration that would let them land here.
 * `podsOnNode` is placement — how many of those are actually on this node. A pod can tolerate a
 * taint and be running somewhere else entirely, so a single number would read as a claim about
 * scheduling that nothing in the data supports.
 */
export interface NodeTaint {
  id: string;
  node: string | null;
  key: string | null;
  value: string | null;
  /** Verbatim from the API, never defaulted — `null` means the taint came back malformed. */
  effect: string | null;
  timeAdded: string | null;
  podsTolerating: number;
  podsOnNode: number;
}

/** One toleration a pod declares, after the injected admission-controller defaults are removed. */
export interface PodToleration {
  key: string | null;
  value: string | null;
  operator: string;
  /** `null` means all effects — a wildcard, not an absence. */
  effect: string | null;
  /** NoExecute only; Kubernetes ignores it on other effects, so it is `null` there. */
  tolerationSeconds: number | null;
  /** `operator: Exists` with no key: tolerates every taint on the cluster. */
  universal: boolean;
  /** Matches no taint on this cluster, so it grants nothing today. `null` = not checked. */
  inert: boolean | null;
  matchesNodes: string[];
}

export interface TolerantPod {
  name: string | null;
  namespace: string | null;
  /** Where the pod is. A fact, never a claim that a toleration put it there. */
  node: string | null;
  phase: string | null;
  tolerations: PodToleration[];
  /** How many injected defaults were filtered out; every pod on a cluster has some. */
  injectedCount: number;
}

export interface TaintsData {
  summary: {
    nodesReporting: number | null;
    taints: number | null;
    distinctTaints: number | null;
    taintedNodes: number | null;
    podsRead: number | null;
    podsWithAuthoredTolerations: number | null;
    podsWithUniversalToleration: number | null;
    allTolerationsInert: boolean;
  };
  taints: NodeTaint[];
  pods: TolerantPod[];
}

/** What `topology.js` returns for one cluster — the payload on a slot's `data`. */
export interface TopologyData {
  summary: {
    totalNodes: number;
    readyNodes: number;
    distinctZones: number;
    distinctNodeGroups?: number;
    isMultiZone: boolean;
    totalPodsAudited: number;
    totalPodsScheduled?: number;
    totalPodCapacity?: number;
  } & Completeness;
  zones: { zone: string; nodeCount: number; podCount: number }[];
  nodeGroups?: NodeGroup[];
  nodes: TopologyNode[];
  taints?: TaintsData;
}

export interface FleetTopology {
  summary: {
    clusters: number;
    unreachable: number;
    totalNodes: number;
    readyNodes: number;
    distinctZones: number;
    distinctNodeGroups?: number;
    totalPodsScheduled?: number;
    totalPodCapacity?: number;
  } & Completeness;
  clusters: (ClusterSlot & { data?: TopologyData })[];
  nodeGroups?: NodeGroup[];
  nodes: TopologyNode[];
  collectedAt?: string;
}

/**
 * `GET /clusters/:id/topology` returns the fan-out envelope for one cluster — `{cluster, ok,
 * data}` with the payload at `.data` — not the fleet-wide `{summary, clusters[]}` shape. This
 * was aliased to `FleetTopology` and the compiler blessed `data.nodes` on it, which reads one
 * level too shallow and renders permanently empty. Two sibling aliases had the same defect;
 * see the per-cluster envelope note on `ClusterCertificates`.
 */
export type ClusterTopology = ClusterGroupEnvelope<TopologyData>;

// -------------------------------------------------------- Distributed traces

/** One resolved endpoint of a hop. `kind` is the evidence class, not a guess. */
export interface TraceEndpoint {
  kind: 'Pod' | 'Service' | 'Node' | 'Endpoint' | 'external' | 'unresolved';
  name: string;
  namespace: string | null;
  ip: string | null;
  port: number | null;
  direction?: string | null;
  fqdn?: string | null;
  /** Which object or field resolved this address. Printed, so a name is never unsourced. */
  evidence: string;
  /** Set on an external endpoint when a cluster object names its address (destination-names.js). */
  destination?: DestinationName;
  /** An external address no object names: the IP is shown with "Undeclared", never a guessed name. */
  undeclared?: true;
}

/** One Envoy response flag, decoded. `known: false` still carries a row — see `traffic.js`. */
export interface TraceFlag {
  flag: string;
  name: string | null;
  meaning: string;
  known: boolean;
}

/** One hop of a journey: one access-log line, from the proxy that wrote it. */
export interface TraceHop {
  seq: number;
  /** The proxy that reported this line. The observer, not necessarily either endpoint. */
  observedBy: { pod: string; namespace: string };
  /** `ingress` is the edge — the hop whose status code the client actually received. */
  role: 'ingress' | 'sidecar';
  spanId: string | null;
  parentSpanId: string | null;
  startTime: string | null;
  /** Milliseconds after the first hop's start. Null when a start stamp is missing. */
  offsetMs: number | null;
  method: string | null;
  path: string | null;
  authority: string | null;
  protocol: string | null;
  routeName: string | null;
  code: number;
  codeClass: 'ok' | 'client' | 'server' | 'no-response';
  durationMs: number | null;
  /** From `x-envoy-upstream-service-time`: the part of `durationMs` the upstream itself spent. */
  upstreamMs: number | null;
  /** `durationMs - upstreamMs`. Null rather than 0 when the subtraction would go negative. */
  proxyOverheadMs: number | null;
  /**
   * This hop's duration minus its callee's — the time that went into the network and the proxies.
   *
   * Null on the last hop, and null whenever the hops do not nest (`Trace.nestingAnomaly`): a
   * negative remainder is clock skew between nodes, not a measurement.
   */
  transitMs: number | null;
  responseFlags: string | null;
  flagDetails: TraceFlag[];
  responseCodeDetails: string | null;
  terminationDetails: string | null;
  from: TraceEndpoint | null;
  /** Where it was sent. `null` means it never reached an upstream — a local 403, or `NR`. */
  to: TraceEndpoint | null;
  bytesSent: number | null;
  bytesReceived: number | null;
}

export type TraceClass =
  | 'app'
  | 'egress-declared'
  | 'egress-undeclared'
  | 'egress-unverified'
  | 'platform'
  | 'probe'
  | 'security-refused'
  | 'direct-or-tls';

export interface Trace {
  traceId: string;
  /** `request-id` means hop nesting was INFERRED from duration; the other two carry span ids. */
  correlatedBy: 'traceparent' | 'b3' | 'request-id';
  requestId: string | null;
  /** Set only when hops disagree about the request id — worth showing, because it is suspicious. */
  requestIds: string[] | null;
  startTime: string | null;
  method: string | null;
  path: string | null;
  authority: string | null;
  /** What the client saw, from the edge hop. Not the same fact as `worstStatus`. */
  finalStatus: number | null;
  finalStatusClass: 'ok' | 'client' | 'server' | 'no-response' | null;
  worstStatus: number | null;
  /** Which hop, 1-based, first went wrong — the root-cause pointer the waterfall highlights. */
  errorHop: number | null;
  hasError: boolean;
  /** The request class of the entry hop (request-class.js); absent on a server older than it. */
  class?: TraceClass;
  /** A 5xx or an upstream-failure flag on an `app` journey. A refusal or a probe is never one. */
  appError?: boolean;
  totalDurationMs: number | null;
  /** Hops THIS WINDOW SAW. Never the request's real topology — see `window.proxies`. */
  hopCount: number;
  hopsDropped: number;
  entryRole: 'ingress' | 'sidecar' | null;
  /** True when hop durations do not nest, so no transit time is published for this trace. */
  nestingAnomaly: boolean;
  flags: string[];
  /** Which liveness poll this journey is (`POLL_RULES` in traces.js), or null for real work. */
  poll: string | null;
  hops: TraceHop[];
  /**
   * Outbound connections this journey's pods opened while it was running, with no correlator to
   * say so — linked by time only (`link: 'inferred'`). Capped; `outboundDropped` counts the rest.
   */
  outbound?: TraceOutboundItem[];
  outboundDropped?: number;
  /**
   * The path this journey took, edge to external dependency (journey-path.js). Not `path`, which is the request's
   * URL path. Null with `pathReason` when no path could be built; absent on an older server.
   */
  journeyPath?: JourneyPath | null;
  pathReason?: string | null;
}

/**
 * One stop on a journey's path. Gateway and workload nodes carry the hop's timing; an external node
 * carries how long its connection stayed open (`openForMs`), never a latency; `seen: false` is a
 * declared destination that opened no connection in this window.
 */
export interface JourneyPathNode {
  id: string;
  kind: 'edge' | 'gateway' | 'workload' | 'external' | 'notRead';
  label: string;
  namespace: string | null;
  pod: string | null;
  traceId?: string; seq?: number; method?: string | null; path?: string | null; code?: number;
  codeClass?: TraceHop['codeClass']; durationMs?: number | null; upstreamMs?: number | null; proxyOverheadMs?: number | null; flags?: string[];
  destination?: DestinationName | null; undeclared?: boolean; ip?: string | null; seen?: boolean;
  openedAtMs?: number | null; openForMs?: number | null; bytesSent?: number | null; bytesReceived?: number | null;
  protocol?: 'http' | 'tcp' | null; failed?: boolean; reason?: string | null;
  /**
   * The Edge node's own facts, from reads the collector already makes: never a timing (the load
   * balancer writes no access log). `null` when the read that produces it failed; a missing key on
   * the payload means an older server. Present only on the `kind: 'edge'` node.
   */
  edge?: EdgeMeta;
}
/** `lb`/`gateways` are `null` only when their Service/Gateway read failed — never for "none found". */
export interface EdgeMeta {
  lb: { type: string | null; hostname: string | null; addressOnly: boolean; externalTrafficPolicy: string | null; sourceRangesCount: number | null } | null;
  gateways: { namespace: string; name: string; servers: { hosts: string[]; tlsMode: string | null; credentialName: string | null }[] }[] | null;
}
/** `inferred` is a join by time: `candidates` is how many requests it chose between. */
export interface JourneyPathEdge { from: string; to: string; link: 'exact' | 'inferred'; candidates: number; transitMs: number | null }
export interface JourneyPath { nodes: JourneyPathNode[]; edges: JourneyPathEdge[] }

export type TraceNodeRef = Pick<ServiceMapNode, 'id' | 'kind' | 'name' | 'namespace' | 'destination'>;

/** One outbound connection linked to a journey by time. See srv/fleet/collectors/outbound.js. */
export interface TraceOutboundItem {
  from: TraceNodeRef;
  to: TraceNodeRef;
  pod: string;
  startTime: string | null;
  /** Milliseconds after the journey's first hop started. */
  offsetMs: number | null;
  durationMs: number | null;
  protocol: 'http' | 'tcp';
  code: number | null;
  failed: boolean;
  bytesSent: number | null;
  bytesReceived: number | null;
  link: 'inferred';
  /** How many inbound requests the pod was serving when the connection opened. 1 is a clean link. */
  candidates: number;
}

/** One workload → destination pair of outbound calls. */
export interface TraceOutboundRow {
  from: TraceNodeRef;
  to: TraceNodeRef;
  connections: number;
  errors: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  protocol: 'http' | 'tcp' | 'mixed';
  /** Null when no line logged bytes; a floor when only some did (`bytesUnknown`). */
  bytesSent: number | null;
  bytesReceived: number | null;
  bytesUnknown: number;
  lastSeen: string | null;
  /** Lines carrying a correlator: already a hop of their journey. */
  exact: number;
  /** Linked by time to a request in flight on the same pod. */
  inferred: number;
  /** No request was in flight when the connection opened (a pool refresh, a background job). */
  unlinked: number;
  /** Inferred links with more than one request in flight: the named one is the innermost. */
  crowded: number;
  sample: { traceId: string; method: string | null; path: string | null; link: 'exact' | 'inferred'; candidates: number; startTime: string } | null;
}

/**
 * Which correlation header the window could be stitched by, and the evidence for that choice.
 *
 * `traceparentAbsent` is a CONFIGURATION finding, not an absence of traffic: Istio's
 * stock JSON access-log format does not name the header, and Envoy only fills it when tracing
 * is enabled on the mesh. The tab says so rather than rendering a shrug.
 */
export interface TraceCorrelation {
  source: 'traceparent' | 'b3' | 'request-id' | null;
  traceparentLines: number;
  b3Lines: number;
  requestIdLines: number;
  uncorrelatedLines: number;
  sampledLines: number;
  traceparentAbsent: boolean;
  nestingInferred: boolean;
  multiHopTraces: number;
  singleHopTraces: number;
}

/** Which proxies contributed lines — the honest denominator for every `hopCount`. */
export interface TraceWindowProxy {
  pod: string;
  namespace: string;
  role: 'ingress' | 'sidecar';
  lines: number;
  parsed: number;
  truncated: boolean;
}

export interface TracesData {
  cluster?: CollectorCluster;
  /** Why there may be nothing to read at all. The same verdict the Traffic tab renders. */
  accessLog: AccessLogVerdict;
  correlation: TraceCorrelation;
  window: {
    proxiesRead: number;
    readsSkipped: boolean;
    proxiesFailed: { pod: string; namespace: string; reason: string | null; detail: string | null }[];
    proxyCandidates: number;
    proxiesSkipped: number;
    proxies: TraceWindowProxy[];
    tailLines: number;
    namespace: string | null;
    /** The namespace scope as sent; null reads every namespace. Gateways are read either way. */
    namespaces: string[] | null;
    /** Every namespace with a running sidecar — the scope control's options. */
    meshNamespaces: { namespace: string; proxies: number }[];
    sinceSeconds: number | null;
    linesRead: number;
    requestsParsed: number;
    linesUnparsed: number;
    truncatedProxies: number;
    oldest: string | null;
    newest: string | null;
  };
  summary: {
    /** When this window was actually read; absent on a server older than the field. */
    readAt?: string;
    traces: number;
    tracesFound: number;
    multiHop: number;
    errorTraces: number;
    /** Journeys with `appError`; absent on a server older than the request class. */
    appErrorTraces?: number;
    /** Kept journeys per request class. */
    classCounts?: Partial<Record<TraceClass, number>>;
    slowTraces: number;
    slowThresholdMs: number;
    hops: number;
    /** Every journey stitched, before the scope and poll filters. */
    journeysSeen: number;
    /** Successful liveness polls left out; a failing poll always stays. 0 when polls are shown. */
    pollsHidden: number;
    pollsHiddenBy: { kind: string; count: number }[];
    pollsShown: boolean;
    /** Journeys that never touched the selected namespaces. */
    outsideNamespace: number;
  } & Completeness;
  /** Every kept journey grouped by method, host and folded path — not only the 200 in `traces`. */
  endpoints: { endpoints: TraceEndpointStat[]; endpointsFound: number };
  /** The same grouping with probes, refusals and direct-IP/TLS noise kept in. */
  endpointsAll?: { endpoints: TraceEndpointStat[]; endpointsFound: number };
  /** What `endpoints` left out, per request class. */
  endpointsFiltered?: { journeys: number; byClass: { class: TraceClass; count: number }[] };
  /** Who called whom, from every parsed line (TCP egress included), not only stitched journeys. */
  serviceMap: { nodes: ServiceMapNode[]; edges: ServiceMapEdge[]; edgesFound: number };
  /** Every outbound call a workload's sidecar logged; absent on a server older than this field. */
  outbound?: { rows: TraceOutboundRow[]; rowsFound: number; connections: number; errors?: number; unrouted: number };
  traces: Trace[];
  /** Present only on the detail route: the one trace asked for, or `null` with a reason. */
  trace?: Trace | null;
  requestedTraceId?: string | null;
  notFoundReason?: 'NOT_IN_WINDOW' | null;
  collectedAt?: string;
}

export interface TraceStatusCount {
  code: number;
  count: number;
}

/** One endpoint in the Traces window. `p95Ms` is null below 20 samples. */
export interface TraceEndpointStat {
  method: string | null;
  host: string | null;
  path: string | null;
  /** The workload that served the journey's entry: the gateway's upstream, or the first sidecar. */
  service: { kind: string; name: string; namespace: string } | null;
  journeys: number;
  errors: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  codes: TraceStatusCount[];
  lastSeen: string | null;
  sampleTraceId: string | null;
  /** Set when `host` is a bare IP a cluster object names; see DestinationName. */
  destination?: DestinationName;
}

export type ServiceMapNodeKind = 'workload' | 'gateway' | 'service' | 'external' | 'clients' | 'nodes' | 'unresolved' | 'mesh';

export interface ServiceMapNode {
  id: string;
  kind: ServiceMapNodeKind;
  workloadKind: string | null;
  name: string;
  namespace: string | null;
  /** Set on an external node only when a cluster object names its address; see DestinationName. */
  destination?: DestinationName;
}

/**
 * Who an external address is, and the cluster object that says so (srv/fleet/destination-names.js).
 * `networkpolicy` is an annotation key, `networkpolicy-prose` its sentence form, `telemetry` a
 * pipeline's export, `ingress-lb` this cluster's own load balancer. `others` are the other names
 * the same address was given.
 */
export interface DestinationName {
  display: string;
  label: string;
  source: 'networkpolicy' | 'networkpolicy-ipblock' | 'networkpolicy-prose' | 'telemetry' | 'ingress-lb';
  key: string | null;
  /** Set when a NetworkPolicy names the address: the policy and, for an ipBlock, its CIDR. */
  namespace?: string;
  policyName?: string;
  cidr?: string;
  qualifier: string | null;
  objects: string[];
  others: string[];
  /** Two equal-rank sources claim the address; `display` joins their names with " or ". */
  ambiguous?: true;
}

export interface ServiceMapEdge {
  from: string;
  to: string;
  calls: number;
  errors: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  codes: TraceStatusCount[];
  /** `tcp`: Envoy logged no HTTP method — a database or TLS passthrough. */
  protocol: 'tcp' | 'http' | 'mixed';
  /** Which proxy's lines the counts come from; `both` when caller and callee were read. */
  observedBy: 'both' | 'caller' | 'callee';
  lastSeen: string | null;
  /** At most 10 journeys the console can open, newest first; absent on an older server. */
  traceIds?: string[];
  traceIdsFound?: number;
}

export type ClusterTracesResponse = ClusterGroupEnvelope<TracesData>;

// -------------------------------------------------------- Cost & budget

/**
 * One node's modelled spend, as `srv/fleet/collectors/cost.js` `priceNodes` returns it.
 *
 * Every money field is `number | null`, and `null` is load-bearing: a node whose instance type is
 * absent from the server's rate card, or whose capacity could not be read, has NO price. The row
 * still appears — with `unpricedReason` naming which of the two it is — because dropping it would
 * quietly shrink the node count, and rendering `0` would read as a free machine.
 */
export interface CostNode {
  name: string;
  zone: string | null;
  instanceType: string | null;
  provider?: string;
  vCpu: number | null;
  memoryGiB: number | null;
  /** Tri-state. `null` means the Node reports no `Ready` condition at all. A NotReady node bills. */
  ready: boolean | null;
  hourlyUsd: number | null;
  monthlyUsd: number | null;
  monthlyEur: number | null;
  monthlyCu: number | null;
  normalizedUnits?: number | null;
  nodeHourlyUsd?: number | null;
  rateSource: 'catalog' | 'derived' | null;
  /** How far this machine's CU-meter dollar equivalent sits from its list price, in percent. */
  modelDivergencePct?: number | null;
  unpricedReason: 'UNKNOWN_INSTANCE_TYPE' | 'NO_INSTANCE_TYPE_LABEL' | null;
}

/** One namespace's share of the bill, weighted by the mean of its CPU and memory request shares. */
export interface CostAttributionRow {
  namespace: string;
  pods: number;
  cpuRequested: number | null;
  memGiBRequested: number | null;
  cpuSharePct: number | null;
  memSharePct: number | null;
  sharePct: number | null;
  monthlyUsd: number | null;
}

/**
 * The capacity nobody requested, as its own row.
 *
 * Not a rounding remainder — it is the most actionable number on the tab, and the reason the
 * namespace rows do not sum to 100%. See the module note in `cost.js`.
 */
export interface CostUnallocated {
  sharePct: number | null;
  monthlyUsd: number | null;
}

/** One selectable machine in the what-if simulator, priced server-side. */
export interface CostCatalogEntry {
  instanceType: string;
  cpu: number;
  memGiB: number;
  normalizedUnits: number | null;
  hourlyUsd: number | null;
  monthlyUsd: number | null;
  monthlyEur: number | null;
  monthlyCu: number | null;
  modelDivergencePct: number | null;
}

export interface CostSummary extends Completeness {
  /** `'unknown'` when the Node list itself could not be read — then every money field is `null`. */
  verdict: 'ok' | 'unknown';
  hourlyUsd: number | null;
  monthlyUsd: number | null;
  monthlyEur: number | null;
  monthlyCu: number | null;
  /**
   * True when at least one node is unpriced, so every total is a LOWER BOUND — the UI must say
   * "at least $x". Distinct from `unavailable`: the numbers present are real.
   */
  costIsFloor: boolean;
  unpricedNodes: number;
  nodeCount: number;
  /** Priced on capacity — the whole machine, which is what the invoice covers. */
  cpuCapacity: number | null;
  memGiBCapacity: number | null;
  /** Utilization denominators — allocatable, because 100% of capacity is unreachable. */
  cpuAllocatable: number | null;
  memGiBAllocatable: number | null;
  requestedCpu: number | null;
  requestedMemGiB: number | null;
  requestedCpuPct: number | null;
  requestedMemPct: number | null;
  /** Live sample; `null` unless metrics-server answered for every billable node. */
  cpuUtilizationPct: number | null;
  memoryUtilizationPct: number | null;
  usageSource: 'metrics-server' | 'metrics-server:partial' | null;
  hoursPerMonth: number;
  /**
   * The Capacity Unit meter, kept beside the USD one and never folded into it.
   *
   * `modelDivergencePct` is the gap between the two — around +20% on the built-in card. It is on
   * the wire so the tab can disclose it, rather than an operator discovering it by multiplying
   * `monthlyCu` by `cuRateUsd` and getting a number that is not `monthlyUsd`. `null` when nothing
   * could be priced: 0% would claim the two models agree.
   */
  cuRateEur: number;
  cuRateUsd: number;
  /** The CU meter's own definition, so the tab's explanation of it is not a second hardcoded copy. */
  cuUnitCpu: number;
  cuUnitMemGiB: number;
  cuHourlyPerUnit: number;
  monthlyUsdOnCuMeter: number | null;
  modelDivergencePct: number | null;
  /** Where the rate card came from: the built-in default, or an operator override. */
  rateCard: string;
  /** Always true. No figure on this tab is read from a bill. */
  estimate: boolean;
}

export interface CostData {
  summary: CostSummary;
  nodes: CostNode[];
  attribution: CostAttributionRow[];
  unallocated: CostUnallocated;
  hyperscalerCatalog: Record<string, CostCatalogEntry[]>;
}

export type ClusterCostResponse = ClusterGroupEnvelope<CostData>;

// ------------------------------------------------------------------- group collectors

/**
 * The response shape shared by the `registerGroupRoutes` pairs in router.js
 * (mesh, capacity, reliability, observability):
 * one rich `data` object per cluster, no fleet-level recomputation of a collector's own
 * counts. `T` is the collector-specific payload riding on each cluster's slot.
 */
export interface FleetGroup<T> {
  summary: { clusters: number; unreachable: number } & Completeness;
  clusters: (ClusterSlot & { data?: T })[];
  collectedAt: string;
}

/** The single-cluster form of the same route pair: one envelope, whose `data` is `T`. */
export type ClusterGroupEnvelope<T> = Envelope<T> & Completeness;

/** Every collector payload in this family carries its own cluster identity and `summary`. */
interface CollectorCluster {
  id: string;
  displayName: string;
  env: string;
}

// -------------------------------------------------------------- workload dependency graph

/** One box in the traffic-flow diagram. */
export interface GraphNode {
  kind: string;
  name: string;
  detail?: string | null;
}

/**
 * One stage of the flow. An empty `items` is rendered greyed, not skipped: "nothing routes
 * to this Deployment" is a finding worth seeing.
 */
export interface GraphStage {
  stage: 'ingress' | 'service' | 'workload' | 'replicaset' | 'pods';
  label: string;
  items: GraphNode[];
}

export interface GraphService {
  name: string;
  type: string;
  clusterIP: string | null;
  ports: { name: string | null; port: number; targetPort: string | number | null; protocol: string }[];
}

export interface GraphIngress {
  kind: 'Ingress' | 'HTTPRoute';
  name: string;
  hosts: string[];
  state?: string | null;
}

export interface GraphReplicaSet {
  name: string;
  revision: string | null;
  desired: number;
  ready: number;
  current: number;
  createdAt: string;
  active: boolean;
}

export interface GraphHpa {
  name: string;
  min: number | null;
  max: number | null;
  current: number | null;
  desired: number | null;
}

/** A ConfigMap/Secret/PVC/ServiceAccount the pod template reads, and how it reads it. */
export interface GraphConfigRef {
  kind: string;
  name: string;
  via: string[];
}

export interface GraphContainerSpec {
  name: string;
  init: boolean;
  image: string | null;
  imageTag: string | null;
  /** Every distinct digest across the running replicas. More than one means they have drifted. */
  digests: string[];
  cpuRequest: number;
  cpuLimit: number;
  memoryRequest: number;
  memoryLimit: number;
  envKeys: string[];
  envFromCount: number;
  ports: { name: string | null; containerPort: number; protocol: string }[];
  probes: { liveness: boolean; readiness: boolean; startup: boolean };
}

export interface WorkloadGraph {
  workload: { kind: string; name: string; namespace: string; cluster: string };
  flow: GraphStage[];
  services: GraphService[];
  hpas: GraphHpa[];
  replicaSets: GraphReplicaSet[];
  ingress: GraphIngress[];
  config: GraphConfigRef[];
  containers: GraphContainerSpec[];
  summary: { unavailable: string[]; truncated: string[] };
}

// -------------------------------------------------------------------- Helm releases

/** One chart dependency as declared in Chart.yaml. */
export interface HelmDependency {
  name: string | null;
  version: string | null;
  repository: string | null;
}

/** A resource the release rendered, parsed out of its manifest. */
/** Ready/desired for a rendered resource that has a health state. Absent for kinds that don't. */
export interface HelmResourceHealth {
  ready: number;
  desired: number;
  state: string;
}

export interface HelmResource {
  kind: string;
  name: string | null;
  namespace: string | null;
  /** True for the kinds the Workloads tab can open — Deployment, StatefulSet, DaemonSet. */
  linkable: boolean;
  /**
   * False when the workload list backing this kind was refused or truncated, so the health join
   * could not be performed. A `health: null` under `healthReadable: false` means "could not
   * tell", NOT "missing" — rendering it as missing states the opposite of the truth.
   */
  healthReadable: boolean;
  /**
   * Live health, or null. Null means one of three things and the UI must not conflate them with
   * "unhealthy": the kind has no health state to report (a ConfigMap), the read failed
   * (`healthReadable: false`), or the object is genuinely not there — a rendered resource
   * missing from the cluster.
   */
  health: HelmResourceHealth | null;
}

/** One entry in a release's revision history — enough for a version timeline, no values. */
export interface HelmRevisionSummary {
  revision: number | null;
  status: string | null;
  chartVersion: string | null;
  appVersion: string | null;
  description: string | null;
  lastDeployed: string | null;
}

export interface HelmRelease {
  name: string;
  namespace: string | null;
  revision: number | null;
  status: string | null;
  description: string | null;
  firstDeployed: string | null;
  lastDeployed: string | null;
  chart: {
    name: string | null;
    version: string | null;
    appVersion: string | null;
    apiVersion: string | null;
    description: string | null;
    type: string | null;
    dependencies: HelmDependency[];
  };
  /**
   * Only what an operator passed with `-f`/`--set`. This is the interesting half: it is the
   * difference between this install and a default one.
   */
  overrides: Record<string, unknown>;
  /** `helm get values --all` — chart defaults with `overrides` merged on top. */
  values: Record<string, unknown>;
  hasChartDefaults: boolean;
  resourceKinds: Record<string, number>;
  resources: HelmResource[];
  resourceCount: number;
  hookCount: number;
  revisions: HelmRevisionSummary[];
  revisionCount: number;
  /** Set when the newest revision is not the deployed one — an upgrade that never landed. */
  pendingRevision: number | null;
}

/**
 * Whether a feature can answer, and if not, exactly why — built by `srv/fleet/capability.js`.
 *
 * The states are not interchangeable and the UI must not flatten them: `forbidden` sends an
 * operator to a role binding, `not-configured` to a controller flag, `not-installed` to nothing at
 * all (the count beside it is true), `unsupported-backend` to a different tool entirely. `trusted`
 * says whether a number rendered next to this verdict is a fact — false means render `Unavailable`,
 * never `0`.
 */
export type CapabilityState =
  | 'available'
  | 'partial'
  | 'forbidden'
  | 'not-installed'
  | 'not-configured'
  | 'stale'
  | 'unsupported-backend'
  | 'unknown';

export interface Capability {
  feature: string;
  state: CapabilityState;
  label: string;
  trusted: boolean;
  cause: string | null;
  detail: string | null;
  /** Labels of the specific reads that could not be performed. */
  missing: string[];
  /** The exact sentence to print. Null only when the state is `available`. */
  sentence: string | null;
  extra?: {
    backend?: string;
    sqlIndistinguishable?: boolean;
    note?: string;
    auditState?: string;
    ageSeconds?: number;
    thresholdSeconds?: number;
    reason?: string;
  };
}

/** Which Helm storage driver holds this cluster's release records. */
export type HelmStorageBackend = 'secret' | 'configmap' | 'none';

export interface HelmData {
  releases: HelmRelease[];
  /**
   * The driver actually in use, established by reading — never assumed. `none` with an `available`
   * capability means both Kubernetes drivers were readable and empty, which an `HELM_DRIVER=sql`
   * installation is indistinguishable from; `capability.extra.note` says so.
   */
  storage: {
    backend: HelmStorageBackend;
    drivers: { id: string; label: string }[];
    capability: Capability;
  };
  /**
   * Per-pane verdicts. Values, Manifest and History share the storage verdict because they come
   * out of the same record; `liveInspection` is a different read with different RBAC and stays
   * usable when the store does not.
   */
  capabilities: {
    releases: Capability;
    values: Capability;
    manifest: Capability;
    history: Capability;
    liveInspection: Capability;
  };
  counts: {
    releases: number;
    namespaces: number;
    notDeployed: number;
    /** Helm-typed Secrets whose payload would not decode; non-zero means the list is short. */
    undecodable: number;
  };
  summary: { unavailable: string[]; truncated: string[] };
}

/** One YAML document out of a release's rendered manifest. */
export interface HelmManifestDocument {
  /**
   * The template that rendered it, from Helm's own `# Source:` comment. Null for a document
   * Helm did not annotate — nothing else in the payload carries this link.
   */
  source: string | null;
  kind: string | null;
  name: string | null;
  namespace: string | null;
  /**
   * True when this document's values were blanked because of its KIND (a Secret, or a kind
   * that could not be parsed and is therefore treated as one), not because a key looked
   * credential-shaped. The UI says so on screen: unexplained `[redacted]` reads as the
   * literal configured value.
   */
  redactedByKind: boolean;
  /** Redacted YAML. Keys always survive; Secret values never do. */
  content: string;
}

/** A file as the chart shipped it — an unrendered template, or something under the chart's files/. */
export interface HelmChartFile {
  name: string;
  type: 'template' | 'file';
  /** The true size, which is larger than `content` when `truncated` is set. */
  bytes: number;
  content: string;
  truncated: boolean;
}

export interface HelmManifestData {
  description?: string | null;
  lastDeployed?: string | null;
  name: string;
  namespace: string;
  revision: number | null;
  status: string | null;
  documents: HelmManifestDocument[];
  chartFiles: HelmChartFile[];
  /** Which storage driver answered for this release, and whether it answered in full. */
  capability?: Capability;
  /** This revision's user-supplied overrides, masked. The `-f`/`--set` half. */
  overrides: Record<string, unknown>;
  /** Chart defaults with `overrides` merged on top — `helm get values --all`, masked. */
  values: Record<string, unknown>;
  /** The chart's own values.yaml for this revision, masked. Empty when the chart shipped none. */
  defaults: Record<string, unknown>;
  hasChartDefaults: boolean;
  /** Chart.yaml as this revision recorded it — the Chart Metadata section on the Values tab. */
  chartMetadata: {
    name: string | null;
    version: string | null;
    appVersion: string | null;
    apiVersion: string | null;
    description: string | null;
    type: string | null;
    home: string | null;
    keywords: string[];
    /** Names only. A maintainer's email and URL are contact details a console has no use for. */
    maintainers: { name: string | null }[];
  };
  counts: {
    documents: number;
    chartFiles: number;
    /** Size of the manifest as stored, before any cap — so a truncated view can say by how much. */
    manifestBytes: number;
    undecodable: number;
  };
  summary: { unavailable: string[]; truncated: string[] };
}

// -------------------------------------------------------------------- one release, live

/**
 * How a resource came to be associated with a release. Never a guess — every value below is
 * carried with the field that proves it, in `evidence`.
 *
 * `helm-owned`             Helm's own `meta.helm.sh/release-name` annotation names this release.
 * `helm-managed`           in the rendered manifest, without those annotations.
 * `owner-reference`        Kubernetes created it for something already resolved.
 * `selector`               a Service, PDB or NetworkPolicy selector matches a resolved workload.
 * `configuration-reference` a resolved pod template names it (a ConfigMap, Secret, PVC, SA).
 * `runtime`                a live pointer — scaleTargetRef, an Ingress backend, a TLS secret.
 */
export type HelmRelationship =
  | 'helm-owned'
  | 'helm-managed'
  | 'owner-reference'
  | 'selector'
  | 'configuration-reference'
  | 'runtime';

/** A native status, per Kind. Null for the Kinds that genuinely have none (ConfigMap, Secret). */
export interface HelmLiveStatus {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'accent' | 'unknown';
  ready?: number;
  desired?: number;
  total?: number;
}

export interface HelmRelatedResource {
  /** `Kind/namespace/name`, with `-` for cluster-scoped. The graph's node id too. */
  id: string;
  kind: string;
  name: string;
  namespace: string | null;
  /** The Resources tab's section heading, decided on the server. */
  group: string;
  relationship: HelmRelationship;
  /** The exact field that proves the relationship, in words. */
  evidence: string;
  status: HelmLiveStatus | null;
  createdAt: string | null;
  /** Per-kind extras: container findings, selectors, ports, keys (never Secret values). */
  facts: Record<string, unknown>;
}

export type HelmEdgeType =
  | 'helm-managed'
  | 'owner'
  | 'selector'
  | 'associated-with'
  | 'targets'
  | 'routes-to'
  | 'tls-binding'
  | 'mounts'
  | 'references';

export interface HelmGraphNode {
  id: string;
  kind: string;
  name: string;
  namespace: string | null;
  group: string;
  relationship: HelmRelationship;
  status: { text: string; tone: HelmLiveStatus['tone'] } | null;
}

export interface HelmGraphEdge {
  id: string;
  from: string;
  to: string;
  type: HelmEdgeType;
  /** The field read to draw this edge. There is no edge type meaning "the names look alike". */
  evidence: string;
  explanation: string;
}

export interface HelmRelatedEvent {
  at: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  type: string;
  reason: string | null;
  message: string;
  source: string | null;
  count: number;
  resource: { kind: string; namespace: string | null; name: string };
}

export interface HelmRelatedData {
  release: { name: string; namespace: string; revision: number | null; status: string | null };
  rendered: {
    count: number;
    kinds: Record<string, number>;
    /**
     * A rendered entry with no live object. `readable: false` means the Kind's own list failed,
     * so its absence is a gap in our view rather than a missing resource.
     */
    missing: { kind: string; name: string; namespace: string | null; readable: boolean }[];
  };
  resources: HelmRelatedResource[];
  counts: {
    total: number;
    byGroup: Record<string, number>;
    byKind: Record<string, number>;
    byRelationship: Record<string, number>;
  };
  graph: { nodes: HelmGraphNode[]; edges: HelmGraphEdge[] };
  events: HelmRelatedEvent[];
  eventCoverage: { namespaceOnly: boolean; limit: number; readable: boolean; truncated: boolean };
  summary: { unavailable: string[]; truncated: string[] };
  collectedAt: string;
}

export interface MeshData {
  cluster: CollectorCluster;
  sidecarCoverage: unknown;
  mtls: { verdicts: unknown; mtlsBasis: string; rootNamespaceSource: string };
  ingressBindingIntegrity: unknown;
  authorizationPosture: unknown;
  summary: Completeness;
  collectedAt: string;
}

/** One node's row in the overcommit ranking. Percentages are null when metrics are absent. */
export interface OvercommitNode {
  name: string;
  cpuRequestedPercent: number | null;
  memoryRequestedPercent: number | null;
  podSlotsPercent: number | null;
  cpuUsagePercent: number | null;
  memoryUsagePercent: number | null;
  cpuRequested: number;
  memoryRequested: number;
  podSlotsUsed: number;
  podSlotsCapacity: number;
}

/** One namespace's row, with the share of its limits that Istio sidecars account for. */
export interface OvercommitNamespace {
  namespace: string;
  cpuRequested: number;
  memoryRequested: number;
  podSlotsUsed: number;
  totalCpuLimit: number;
  totalMemoryLimit: number;
  sidecarCpuLimit: number;
  sidecarMemoryLimit: number;
  /** 0–1. The fraction of this namespace's CPU limit that is sidecar, not application. */
  sidecarCpuLimitShare: number;
  sidecarMemoryLimitShare: number;
}

/**
 * Capacity and headroom for one cluster, as `srv/fleet/collectors/capacity.js` returns it.
 *
 * Was `[key: string]: unknown`, which made every field below invisible to the compiler and to
 * anyone reading the type — six of the catalogue's unrendered features lived behind that index
 * signature. Typed here so a rename in the collector breaks the build instead of blanking a
 * tile.
 */
export interface CapacityData {
  cluster?: CollectorCluster;
  overcommit: {
    nodes: OvercommitNode[];
    namespaces: OvercommitNamespace[];
    /** Cluster-wide sidecar share of all declared limits, 0–1. "How much of this is Istio." */
    sidecarCpuLimitShare: number;
    sidecarMemoryLimitShare: number;
    /** Sum of declared limits, in cores and bytes. Meaningful only with `limitSumIsFloor`. */
    totalCpuLimit: number;
    totalMemoryLimit: number;
    /**
     * True when at least one container declares no limit, so the sums above are a **floor**:
     * an unlimited container contributes 0 to a total it can in fact exceed without bound.
     * Printing the sum without this flag is the more dangerous of the two numbers.
     */
    limitSumIsFloor: boolean;
  };
  unboundedContainers: {
    totalEffectiveContainers: number;
    /** Containers with no CPU limit. Distinct from `noEitherLimit`, which is the intersection. */
    noCpuLimit: number;
    noMemoryLimit: number;
    noEitherLimit: number;
    limitSumIsFloor: boolean;
  };
  qos: { counts: Record<string, number>; total: number };
  /**
   * Whether the metrics API answered, and if not, why not.
   *
   * `installed` is **tri-state**: `true`/`false` are confirmed either way, and `null` means the
   * probe itself was refused (403/401) or errored — so nothing is known. Typing it as `boolean`
   * would collapse "forbidden" into "not installed", which are opposite operator actions: one
   * is an RBAC rule to add, the other a module to enable.
   */
  metricsServer: {
    installed: boolean | null;
    reporting: boolean;
    reason: 'BACKEND_DOWN' | 'NOT_INSTALLED' | 'FORBIDDEN' | 'UPSTREAM' | null;
  };
  pending: { count: number; items: PendingPod[] };
  nodesWithProblems: number;
  summary?: Completeness;
}

/** A pod the scheduler could not place — `PodScheduled=False`. */
export interface PendingPod {
  name: string;
  namespace: string;
  reason: string;
  message: string | null;
  since: string | null;
}

export interface ReliabilityData {
  summary: {
    /** 'unknown' means the pod sweep itself failed; every array below is then empty by
     *  construction, not because the fleet is clean. */
    verdict: 'ok' | 'unknown';
    crashLoops: number;
    /**
     * `null`, never 0, when the pod → ReplicaSet → Deployment owner chain could not be built: the
     * collector evaluates no drift at all in that case and every `rollouts.deployments` entry
     * carries `ownerResolution: 'unavailable'`. Typing this as `number` is what would let an unread
     * fact render as a clean zero.
     */
    driftedDeployments: number | null;
    /**
     * Containers that were looked at and could not be compared — the live image is a bare image ID.
     * A different fact from "no drift found", and `null` under the same unread rule as the count
     * above. A clean drift verdict needs `driftedDeployments === 0` AND this at 0.
     */
    uncomparableImages: number | null;
    staleStatefulSets: number;
    underCapacity: number;
    daemonSetsStuck: number;
    zeroEndpointServices: number;
  } & Completeness;
  crashLoops: unknown[];
  rollouts: { deployments: unknown[]; statefulSets: unknown[] };
  daemonSets: unknown[];
  underCapacity: unknown[];
  zeroEndpointServices: unknown[];
}

/**
 * A wiring verdict — "are the objects that exist actually connected to anything".
 *
 * `NOT_INSTALLED` is a different answer from `NO_TARGETS`: the first says the CRD is not served,
 * the second says it *is* served and nothing is wired to it. `UNKNOWN` is a third, and the one
 * that must never be drawn as either — see `srv/fleet/collectors/observability.js:196-224`,
 * which returns exactly these two fields and nothing else.
 */
export interface WiringVerdict {
  verdict: string;
  reason: string | null;
}

export interface ObservabilityData {
  summary: Completeness;
  prometheusOperator: {
    installed: Record<string, { state: string; evidence?: string | null }>;
    counts: { prometheuses: number; servicemonitors: number; podmonitors: number; prometheusrules: number };
    /**
     * Whether ServiceMonitor/PodMonitor objects have been **declared**, not whether Prometheus
     * is scraping them. `observability.js` names the verdict `TARGETS_DECLARED` for exactly
     * this reason: an apiserver-only reader can see the objects exist, never that Prometheus
     * picked them up — that lives in Prometheus's own `/targets` API, out of scope here.
     */
    scrapeWiring: WiringVerdict;
    /** Whether PrometheusRule objects exist. Same caveat: declared, not confirmed loaded. */
    alertRules: WiringVerdict;
    /** Reads that could not be made at all. Non-empty means `counts` are floors, not totals. */
    unavailablePaths: string[];
  };
  telemetry: {
    installed: Record<string, { state: string; evidence?: string | null }>;
    logPipelines: unknown;
    tracePipelines: unknown;
    metricPipelines: unknown;
  };
  agentCoverage: { recognizedAgents: unknown[] | null };
}

// ---------------------------------------------------------------------------- summary

/**
 * One health finding, relayed from the collector that owns the number.
 *
 * Not computed in the browser and not recomputed on the server either — `srv/fleet/signals.js`
 * reads it straight out of the owning collector's payload, from the same sweep and the same
 * cache entry the tab behind the tile reads. So "3 containers crashlooping" on the Overview and
 * the three rows on the Workloads tab cannot disagree.
 *
 * **Render it, do not do arithmetic on it.** The server has already decided everything the phrase
 * depends on: singular vs plural against the merged total, and whether the number sums across
 * clusters (counts do) or takes the worst value (anything with a `unit` does, because two clusters
 * at 100% are not 200%). Re-deriving any of that in the browser puts a second owner on the fact.
 */
export interface HealthSignal {
  /**
   * Reads as `${count}${unit ?? ''} ${label}` — "3 containers crashlooping", "40% of namespaces
   * have no ResourceQuota". Already agrees with `count`, and on a fleet-wide rate already carries
   * its "(worst of N clusters)" qualifier.
   */
  label: string;
  /** null for a condition that is its own finding, e.g. "single availability zone". */
  count: number | null;
  /** `bad` = look now; `warn` = worth knowing. */
  tone: 'bad' | 'warn';
  /** Appended to the number with no space. Only `'%'` today. Also marks the finding as a rate. */
  unit?: string;
  /** Which clusters contributed, on the fleet-wide response. Empty on a per-cluster one. */
  clusters?: string[];
}

/**
 * One group's verdict. **`state` and `health` answer different questions and must stay apart.**
 *
 * - `state` is completeness: did every read succeed? It never looks at what came back.
 * - `health` is the findings: is what came back healthy?
 *
 * Conflating them was a real bug, not a hypothetical: a cluster whose reads are all granted and
 * all answer, with two containers in CrashLoopBackOff, reported `state: 'ok'` on all seventeen
 * groups — so the Overview showed seventeen green pills and "Nothing to triage" over a broken
 * cluster. `health: 'unknown'` is the honest answer when nothing could be read; it is never
 * `'clear'`, because a topic nobody could look at has no clean bill of health to give.
 */
export interface GroupSummary {
  state: 'ok' | 'degraded' | 'error';
  /** `partial` = read incomplete but nothing found wrong in the part that arrived. */
  health: 'unknown' | 'attention' | 'warn' | 'partial' | 'clear';
  /** Worst first. Empty means nothing was found, which is only reassuring if `state` is ok. */
  signals: HealthSignal[];
  unavailable: string[];
  truncated: string[];
  /** True/false/null the same way `absentList` reports it: null means unresolved, not "no". */
  absent: boolean | null;
  /**
   * The Overview tile's headline and split bar — `/clusters/:id/summary` only, and only for the six
   * Overview topics (`STATS` in srv/fleet/signals.js). `null` when the read failed: never zeros.
   * Absent on the fleet-wide `/summary` and from a server older than the field.
   */
  stats?: TileStats | null;
}

export type StatTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'unknown';

export interface TileStats {
  /** Counts in reading order; `count: null` is an unread number, `of` a denominator ("2 of 3"). */
  headline: Array<{ count: number | null; label: string; of?: number | null; tone?: 'bad' | 'warn' }>;
  /** One bar whose parts sum to `total`; `null` when the list behind it was not read. */
  split: { total: number; parts: Array<{ key: string; label: string; count: number; tone: StatTone }> } | null;
  /** A list behind these counts stopped at the paging ceiling: every count is a floor. */
  atLeast: boolean;
}

/**
 * The thirteen feature groups, in the order `SUMMARY_GROUPS` declares them on the server.
 * Exported because the cluster Overview renders one tile per group and needs to iterate them
 * in a stable order — `Object.keys` on the response would be at the mercy of JSON key order.
 */
export type SummaryGroupKey =
  | 'health' | 'compliance' | 'workloads' | 'networking' | 'storage' | 'security'
  | 'autoscaling' | 'certificates' | 'topology' | 'mesh' | 'capacity' | 'reliability'
  | 'observability';

export interface SummaryResponse {
  groups: Record<SummaryGroupKey, GroupSummary>;
  collectedAt: string;
}

/** A cluster's own verdict per group, without the fleet rollup flattening it away. */
export type PerClusterGroups = Record<string, Partial<Record<SummaryGroupKey, Pick<GroupSummary, 'state' | 'health' | 'signals'>>>>;

/**
 * `GET /summary` — fleet-wide, plus the per-cluster breakdown the rail's status dots read.
 *
 * `perCluster` exists so a dot can say *which* cluster is unhappy and *why* without a request
 * per cluster: the fan-out already visited every one of them, and the old response threw that
 * dimension away before it reached the browser.
 */
export interface FleetSummaryResponse extends SummaryResponse {
  perCluster: PerClusterGroups;
}

/**
 * `GET /clusters/:id/summary` — the same thirteen verdicts for one cluster, which is what the
 * cluster Overview tab renders. `cluster` rides along so the identity strip does not need a
 * second request to name what it is describing.
 */
export interface ClusterSummaryResponse extends SummaryResponse {
  cluster: Cluster;
}

// ------------------------------------------------------------- OIDC bootstrap onboarding

/** `POST /clusters/bootstrap-oidc` — step 1: starts the PKCE flow, browser redirects next. */
export interface OidcBootstrapStart {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string;
  note: string;
}

/**
 * `GET /clusters/bootstrap-oidc/callback` — step 2, the issuer's redirect target. The
 * browser navigates here directly (it is not fetched by `api.ts`), so this type documents
 * the response shape for whatever page reads `window.location` after the redirect lands;
 * it is the same 201 shape as `OnboardResult`, plus the fixed `onboardedVia`.
 */
export interface OidcBootstrapResult extends Omit<OnboardResult, 'onboardedVia'> {
  onboardedVia: 'oidc-bootstrap';
}

export interface FleetDrift {
  summary: {
    totalWorkloadsCompared: number;
    driftedWorkloadsCount: number;
    totalClusters: number;
    k8sVersions: string[];
    hasK8sDrift: boolean;
  } & Completeness;
  clusterParity: (Completeness & {
    id: string;
    displayName: string;
    env: string;
    ok: boolean;
    version: string;
    nodesTotal: number;
    nodesReady: number;
    /** What the scheduler can hand out. This is what the parity table compares on, and it
     *  is the same number the cluster's own detail page shows — raw capacity is deliberately
     *  not sent here, so the two pages cannot disagree. */
    cpuAllocatable: number;
    memoryAllocatable: number;
    isDrifted?: boolean;
  })[];
  items: {
    name: string;
    namespace: string;
    kind: string;
    isDrifted: boolean;
    clusterVersions: Record<string, { env: string; image: string | null; replicas: number; ready: number }>;
  }[];
  collectedAt?: string;
}


// ------------------------------------------------------------- Istio traffic errors

/**
 * Whether Envoy is writing access logs, and which Telemetry CR decided it.
 *
 * `off` is a finding, not an error: the cluster is healthy, the tab simply has no source. `unknown`
 * is the third state and must never be collapsed into `off` — a Telemetry CR this reader could not
 * list tells us nothing about whether logging is on, and rendering "logging is off" from a refused
 * read is the same false-confidence bug as rendering `0` from a 403.
 */
/**
 * One `extensionProviders` entry from the mesh ConfigMap, resolved by name from the Telemetry CR.
 *
 * `readable` is the whole point and it is three-valued. A mesh can declare both `stdout-json`
 * (`envoyFileAccessLog` → `/dev/stdout`, which is exactly the stream `pods/log` returns) and
 * `otel-logs` (`envoyOtelAls` → the OTLP gateway, which writes nothing to stdout at all). Switch
 * the Telemetry CR from the first to the second and this tab's pod-tailing read still succeeds —
 * it just finds no request lines. `null` means the provider's implementation key is one this
 * console does not recognise: not readable, not unreadable, unknown, and never to be collapsed
 * into `false`, which would silently skip the read on a provider that might well write to stdout.
 */
export interface AccessLogProvider {
  name: string;
  /** `file` | `otlp` | `grpc` | `not-access-log` | `unknown` | `unresolved` (not in the mesh config). */
  kind: string;
  /** The mesh-config key that decided it, e.g. `envoyFileAccessLog`. Null when unresolved. */
  implementation: string | null;
  readable: boolean | null;
  /** `/dev/stdout` for a file provider, `service:port` for a network sink. */
  destination: string | null;
  /** Which field vocabulary its labels speak: `envoy`, `otel`, `custom`, or null for the default. */
  fields: string | null;
}

export interface AccessLogVerdict {
  state: 'on' | 'off' | 'unknown';
  reason: string | null;
  detail: string | null;
  providers: string[];
  scope?: 'mesh' | 'partial';
  decidedBy: {
    name: string;
    namespace: string;
    scope: 'mesh' | 'namespace';
    providers: string[];
    selector: Record<string, string> | null;
  }[];
  /** Every named provider, resolved against the mesh ConfigMap. Same order as `providers`. */
  providerDetail: AccessLogProvider[];
  /** Can this tab see these requests at all? Three-valued; see {@link AccessLogProvider}. */
  readable: boolean | null;
  /** Providers the Telemetry CR names that the mesh config does not declare. */
  unresolvedProviders: string[];
  /**
   * The log is written somewhere this tab cannot follow — as opposed to not written at all.
   *
   * Both give `readable: false`, and the difference decides what the UI may promise. A network
   * sink means the requests really are recorded and "open the destination" is good advice; a
   * provider declared for tracing rather than access logging records nothing anywhere, and there
   * is no destination to open.
   */
  recordedElsewhere: boolean;
  /** The mesh ConfigMap could not be read or parsed, so no provider could be resolved. */
  meshUnavailable: boolean;
  why: string;
}

/** An address, and the object that reports it — or a plain statement that nothing does. */
export interface TrafficEndpoint {
  /**
   * `null` on the one collapsed `external` row (D1): external peers are counted, never addressed,
   * so their addresses are not on the wire. `distinct` then says how many were folded into it.
   */
  ip: string | null;
  distinct?: number;
  port: number | null;
  /** A real Kind when something claims the address; `external` or `unresolved` when nothing does. */
  kind: string;
  name: string;
  namespace: string | null;
  node?: string | null;
  service?: string | null;
  /** The field or object that proves the mapping. Shown on hover, so a row can be checked. */
  evidence: string;
  count?: number;
  /** Set on an external upstream only when a cluster object names its address; see DestinationName. */
  destination?: DestinationName;
}

/** Envoy's own name for where it sent the request: `direction|port|subset|FQDN`. */
export interface TrafficUpstream {
  raw: string;
  direction: string | null;
  port: number | null;
  subset: string | null;
  fqdn: string | null;
  service: { kind: string; name: string; namespace: string; evidence: string } | null;
}

/** One failure shape — the same code, method, host, path and upstream, however many times it hit. */
export interface TrafficErrorGroup {
  key: string;
  code: number;
  /** `no-response` is `response_code: 0` — a connection Envoy never answered. Not a 5xx. */
  class: 'server' | 'client' | 'no-response';
  method: string | null;
  path: string | null;
  authority: string | null;
  protocol: string | null;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  responseFlags: string[];
  responseCodeDetails: string[];
  transportFailures: string[];
  p50Ms: number | null;
  maxMs: number | null;
  upstream: TrafficUpstream | null;
  gateway: { name: string; namespace: string; host: string; port: number | null; evidence: string } | null;
  destination: TrafficEndpoint | null;
  sources: TrafficEndpoint[];
  proxies: { pod: string; namespace: string; container: string; count: number }[];
  /** Envoy request ids, for correlating a group against the pod log the tab links to. */
  samples: string[];
  /**
   * What failed versus what was refused, from the edge classifier. Optional: an older srv does not
   * send it, and a group without one is shown ungrouped rather than guessed into a bucket. `null`
   * is srv's unclassified group, which is not the same as absent.
   */
  bucket?: FailureBucket | null;
  /** The edge class, on groups read only on the ingress gateways. Absent on sidecar groups and from an older srv. */
  edgeClass?: EdgeClass;
}

/**
 * `app-failed` and `not-routed` are the operator's problems; `policy-blocked` and `tls-rejected` are
 * the edge working. `direct-ip` is a request with no Host, an IP Host or one no Gateway admits:
 * scanners and misdialled clients, not the app.
 */
export type FailureBucket = 'app-failed' | 'not-routed' | 'policy-blocked' | 'tls-rejected' | 'direct-ip';

/**
 * Exactly how much was read.
 *
 * Every number on this tab describes this window and nothing wider, so the window is part of the
 * payload rather than a footnote: a tail of N lines has no denominator, which is why the tab shows
 * counts and never rates.
 */
export interface TrafficWindow {
  proxiesRead: number;
  /**
   * `reason` is nullable: `readProxyLogs` carries the error's code when it has one and `null` when
   * the failure had none, and both the Traffic and Traces collectors publish that field verbatim.
   * It was declared non-null here, which the compiler then enforced against the Traces window —
   * the type was wrong, not the payload.
   */
  proxiesFailed: { pod: string; namespace: string; reason: string | null; detail: string | null }[];
  proxyCandidates: number;
  proxiesSkipped: number;
  tailLines: number;
  namespace: string | null;
  sinceSeconds: number | null;
  linesRead: number;
  requestsParsed: number;
  /** Lines that were not JSON request records — proxy chatter, or a non-JSON access-log format. */
  linesUnparsed: number;
  truncatedProxies: number;
  oldest: string | null;
  newest: string | null;
  /**
   * No proxy was read, because the mesh sends its access log somewhere this tab cannot follow.
   * The zeros below it are then "nothing was read", not "nothing was wrong" — every consumer of
   * `summary` has to say so rather than render a confident 0.
   */
  readsSkipped: boolean;
}

/**
 * One latency bucket — a destination service, one route, or one TCP connection destination.
 *
 * The percentiles are nearest-rank over the durations actually observed in the window, so every
 * millisecond figure here is a duration some real request reported rather than an interpolated
 * one. `samples` is the n behind them and is not decoration: a p99 over 4 observations and a p99
 * over 4000 are different claims, and nothing else on the row distinguishes them.
 *
 * `requests` counts records; `samples` counts the subset that carried a duration. They differ
 * whenever Envoy logged a record with no duration field, which is why the table shows both.
 *
 * `method`, `authority` and `path` are present on route buckets only. On a **connection** bucket
 * every percentile means the **lifetime of the connection**, not the latency of a request — see
 * `isHttpRecord` in `srv/fleet/collectors/traffic.js`. The UI must label them as lifetimes; the
 * two are never pooled, because a database connection held open for seven minutes is healthy and
 * pooling it produced a p99 of 210 seconds that described nothing.
 */
export interface TrafficLatencyBucket {
  key: string;
  /** The resolved destination Service, with the field that proves it. Null when nothing claims it. */
  service: { kind: string; name: string; namespace: string; evidence: string } | null;
  /** Route buckets only. */
  method?: string | null;
  authority?: string | null;
  path?: string | null;
  requests: number;
  errors: number;
  server: number;
  client: number;
  noResponse: number;
  lastSeen: string | null;
  /** How many of `requests` carried a duration — the n behind the percentiles below. */
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** A share of this bucket's own records. Deliberately not named a rate. */
  errorShare: number | null;
}

/**
 * All traffic in the window grouped for latency rather than for failure.
 *
 * Free to compute: the durations were already parsed for the error groups and then dropped. Read
 * by the Observability tab, which shares the Traffic Errors tab's single cached access-log read
 * rather than tailing the proxies a second time.
 */
export interface TrafficLatency {
  /** Per destination Service, HTTP requests only. Slowest first on p95. */
  services: TrafficLatencyBucket[];
  /** Per method + host + path + service, HTTP requests only. */
  routes: TrafficLatencyBucket[];
  /** Non-HTTP records, per destination. Percentiles here are connection lifetimes. */
  connections: TrafficLatencyBucket[];
  /** HTTP requests whose upstream resolved to no Service — an attribution gap, stated not hidden. */
  unresolvedRequests: number;
  httpRequests: number;
  connectionRecords: number;
}

/**
 * Which bucket a Host header fell into, and why.
 *
 * Derived from cluster evidence, never from a literal. `corporate` means the host matched a suffix
 * configured in `FLEET_CORPORATE_DOMAIN_SUFFIXES`; `declared` means an Istio Gateway in this cluster
 * admits it; `infra` is the named cluster-plumbing list (healthz, connectivity-proxy, kiali…);
 * `address` is somebody dialling the load balancer by IP; `none` is a record with no Host header at
 * all, which is its own printable row and not a dropped line.
 */
export type IngressHostGroup = 'corporate' | 'declared' | 'infra' | 'address' | 'other' | 'none';

/** An object that declares a host — an Istio VirtualService, an Ingress or a Gateway API HTTPRoute. */
export interface IngressRouteRef {
  kind: 'VirtualService' | 'Ingress' | 'HTTPRoute';
  name: string;
  namespace: string;
  /** The field that proves it, quoted. */
  evidence: string;
  /** The pattern that matched — `*`, the exact host, or a `*.suffix`. */
  matched: string;
}

/** A nearest-rank latency summary over the durations actually observed. */
export interface IngressLatency {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

/**
 * Requests per second over the window, computed per proxy and then summed.
 *
 * `perSecond` is `null` whenever the figure would not mean a rate — no proxy returned two
 * timestamped lines, or one proxy's span is under 30 s. `why` carries the sentence to print in its
 * place; it is never an empty string, so the UI always has something honest to say.
 */
export interface IngressRate {
  perSecond: number | null;
  contributors: {
    proxy: string;
    records: number;
    /** How many of `records` carried a start_time — the n behind this proxy's figure. */
    timed: number;
    spanSeconds: number | null;
    perSecond: number | null;
  }[];
  shortestSpanSeconds: number | null;
  suppressed: boolean;
  why: string;
}

/**
 * One published host, as the edge saw it.
 *
 * `host` is `null` on exactly one row — the no-Host-header bucket, keyed `(no host header)`. It
 * carried 318 of 1485 records on the cluster this was built against, so it is a finding and not
 * noise.
 *
 * `bytesSent`/`bytesReceived` are `null` when not one line recorded the field, and `0` when lines
 * did record it and the answer was zero. Those are different claims: `bytes_received` is genuinely
 * 0 on every line of a live ingress window, because probes and plain GETs carry no request body.
 */
export interface IngressHost {
  key: string;
  host: string | null;
  group: IngressHostGroup;
  /** The configured suffix that matched, when `group` is `corporate`. */
  matchedSuffix: string | null;
  /** The Gateway admitting this host, independent of the bucket — a corporate domain no Gateway serves is a finding. */
  gateway: { name: string; namespace: string; host: string; port: number | null; evidence: string } | null;
  /** Every VirtualService, Ingress and HTTPRoute declaring it. Empty means nothing in the cluster publishes it. */
  servedBy: IngressRouteRef[];
  requests: number;
  ok: number;
  /** 3xx, kept apart from 2xx: a host answering 97% 302 is a redirect loop, not a healthy host. */
  redirect: number;
  client: number;
  server: number;
  noResponse: number;
  /** A share of this host's own records in the window. Deliberately not named a rate. */
  errorShare: number | null;
  /** End-to-end, from `duration`. */
  total: IngressLatency;
  /** Upstream only, from `upstream_service_time`. Fewer samples than `total` by design. */
  upstream: IngressLatency;
  /** Median of `duration − upstream_service_time`: this proxy's own work plus the client leg. */
  overheadMs: number | null;
  methods: string[];
  paths: { path: string; count: number }[];
  codes: { code: number; class: string; count: number }[];
  flags: string[];
  details: string[];
  /** Distinct peer addresses. See {@link IngressClient} on what "client" means here. */
  clients: number;
  externalClients: number;
  /** Distinct SNI values offered for this host. */
  sni: number;
  ports: { port: number | null; count: number }[];
  bytesSent: number | null;
  bytesReceived: number | null;
  proxies: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** Which edge class this host's records fell into. Optional: an older srv does not classify. */
  edgeClass?: EdgeClass;
  /** Who a bare-IP host is, when a cluster object names the address. Bare-IP hosts only. */
  destination?: DestinationName;
  /** The published chain behind the host: DNSEntry, then each Gateway server and its certificate. */
  chain?: IngressHostChain;
}

/**
 * The traffic class every edge record is placed in, first match wins (srv `classifyEdgeRecord`):
 * TLS rejected before HTTP, blocked by an AuthorizationPolicy, dialled by IP or an unknown host,
 * the platform health probe, platform system hosts, and app traffic — the only class whose errors
 * and latency are the operator's.
 */
export type EdgeClass = 'tls-rejected' | 'policy-blocked' | 'direct-ip' | 'probe' | 'platform' | 'app';

export interface IngressHostChain {
  /** `null` = no DNSEntry publishes the host; absent = the DNSEntry read failed, so the gap is unknown. */
  dns?: { name: string; dnsName: string; ready: boolean | null } | null;
  /** Absent = the Gateways read failed, so which servers admit the host is unknown. */
  servers?: {
    gateway: string;
    port: number | null;
    tlsMode: string | null;
    credentialName: string | null;
    /** `null` = no Certificate matches the server's Secret; absent = the Certificates read failed. */
    certificate?: { namespace: string; name: string; expires: string | null; daysLeft: number | null; ready: boolean | null } | null;
  }[];
}

/** One `classes.rows` entry: how many edge records, and HTTP requests, fell into a class. */
export interface EdgeClassRow {
  key: EdgeClass;
  records: number;
  requests: number;
  codes: { code: number; count: number }[];
}

/** Class 6 only. `p50Ms`/`p95Ms` are null below `minSamples` — a p95 over five lines is not one. */
export interface IngressAppTraffic {
  requests: number;
  errors: number;
  server: number;
  client: number;
  notFound: number;
  samples: number;
  minSamples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  hosts: { host: string; requests: number; errors: number }[];
}

/** A cert-manager Certificate. Expiry is from `status`, never from the Secret. */
export interface IngressCertificate {
  namespace: string;
  name: string;
  secretName: string | null;
  commonName: string | null;
  dnsNames: string[];
  expires: string | null;
  daysLeft: number | null;
  ready: boolean | null;
  issuer: string | null;
  /** Gateway server keys that name this certificate's Secret. */
  usedBy: string[];
  /** cert-manager's `status.renewalTime`; absent from an older srv. */
  renewalDate?: string | null;
  /** The renewal time has passed and the certificate is still the old one. */
  renewalOverdue?: boolean | null;
}

export interface IngressDnsEntry {
  namespace: string;
  name: string;
  dnsName: string;
  targets: string[];
  state: string | null;
}

/** An AuthorizationPolicy selecting the ingress gateway. `remoteIpBlocks` is a count, never the list. */
export interface IngressAccessPolicy {
  namespace: string;
  name: string;
  action: string | null;
  selector: Record<string, string> | null;
  remoteIpBlocks: number;
  rules: number;
  /**
   * Requests this policy refused. `null` for an ALLOW policy when more than one ALLOW policy selects
   * the gateway: Envoy logs a no-match denial as `[none]`, so it cannot be pinned on one of them.
   */
  denied: number | null;
}

export interface IngressAccess {
  policies: IngressAccessPolicy[];
  deniedTotal: number;
  deniedByHost: { host: string; count: number }[];
  /** Counts over every peer seen. No address: external peers are never listed (D1). */
  peers: { distinct: number; internal: number; external: number; externalAllowed: number; externalBlockedOnly: number; externalTlsOnly?: number };
  /** An EnvoyFilter enabling PROXY protocol on the gateway: the source address is the real one. `null` = not read. */
  proxyProtocol: boolean | null;
  peerAuthentications: { namespace: string; name: string; mode: string | null; selector: Record<string, string> | null }[];
  unavailable: { authorizationPolicies: boolean; peerAuthentications: boolean };
}

/** A deciding AuthorizationPolicy's rule. `ipBlocks` is a count; the CIDRs are in the live YAML only. */
export interface RefusedRule { paths: string[]; methods: string[]; hosts: string[]; principals: string[]; ipBlocks: number }
/**
 * How the decider was determined: `named` from Envoy's own `matched_policy[...]`, `elimination`
 * when `[none]` and exactly one ALLOW policy selected the proxy, `inferred` otherwise (more than one
 * selecting ALLOW policy).
 */
export type RefusedDecidedBy = 'elimination' | 'inferred' | 'named';
export interface RefusedDecider { namespace: string; name: string; action: string; policyInferred: boolean; decidedBy: RefusedDecidedBy; rules: RefusedRule[] }
/** One group of refused requests (srv/fleet/collectors/refusals.js). `clients` counts, never lists. */
export interface IngressRefusedRow {
  tier: 'edge' | 'sidecar';
  namespace: string;
  method: string | null;
  authority: string | null;
  path: string | null;
  edgeClass: string | null;
  code: number;
  responseCodeDetails: string[];
  responseFlags: string[];
  reason: string;
  tlsBeforeHttp: boolean;
  /** `null` = the policies were not read; `[]` = no policy decided (a missing route, a bad Host). */
  decidedBy: RefusedDecider[] | null;
  firstSeen: string | null;
  lastSeen: string | null;
  count: number;
  clients: number;
}
export interface IngressRefused { rows: IngressRefusedRow[]; rowsFound: number; requests: number; policiesUnavailable: boolean }

/** `applies: false` means its `proxyVersion` regex cannot match the running istiod — dead config. */
export interface IngressEnvoyFilters {
  istioVersion: string | null;
  items: { namespace: string; name: string; proxyVersion: string | null; applies: boolean | null }[];
  dead: number;
  unavailable: boolean;
  reason: string | null;
}

export interface IngressLb {
  services: string[];
  hostnames: string[];
  /** Addresses the provider published as IPs (Azure, GCP), with no hostname to look up. */
  ips: string[];
  dns: { hostname: string; ips: string[]; resolvedAt: string | null; error: string | null }[];
}

export type IngressAttentionKind =
  | 'cert-expiry'
  | 'app-5xx'
  | 'app-404'
  | 'idle-host'
  | 'permissive-mtls'
  | 'dead-envoyfilter'
  | 'join-gap';

/** One row of the Overview's attention list. `section` is the `?section=` it deep-links to. */
export interface IngressAttention {
  severity: 'critical' | 'warning' | 'info';
  kind: IngressAttentionKind;
  title: string;
  detail: string;
  section: string;
  /** The object the row is about. Shape not relied on here; only `section` drives the link. */
  ref?: unknown;
}

/**
 * One address that sent requests — the **immediate peer**, not necessarily the originator.
 *
 * Behind a corporate load balancer this is the load balancer. The real originator would be
 * `x-forwarded-for`, which this collector deliberately never reads: it identifies a person and
 * their network path, and a log line is application data. The column is labelled as the peer.
 *
 * `connects` counts `CONNECT` requests from this address — somebody probing the gateway as an open
 * forward proxy. It found 53 such attempts on the cluster this was built against.
 */
export interface IngressClient {
  key: string;
  /**
   * `null` on the single `{key: 'external', kind: 'external'}` row (D1): internal peers are listed,
   * external ones only counted, in `distinct`. No external address is on the wire.
   */
  ip: string | null;
  distinct?: number;
  /** How the address resolved: a Pod/Service/Node in this cluster, `external`, or `unresolved`. */
  kind: string;
  name: string;
  namespace: string | null;
  external: boolean;
  evidence: string;
  requests: number;
  ok: number;
  redirect: number;
  client: number;
  server: number;
  noResponse: number;
  errorShare: number | null;
  connects: number;
  hosts: number;
  topHosts: { host: string; count: number }[];
  codes: { code: number; class: string; count: number }[];
  methods: string[];
  bytesSent: number | null;
  bytesReceived: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** One Envoy `%RESPONSE_FLAGS%` code, decoded. `known: false` means this build does not have it. */
export interface IngressFlag {
  flag: string;
  name: string | null;
  meaning: string | null;
  known: boolean;
  count: number;
  codes: { code: number; class: string; count: number }[];
  /** Sample `response_code_details`, which is what makes NR decodable. */
  details: string[];
  hosts: number;
  lastSeen: string | null;
}

/** One listener port, from `downstream_local_address` — the socket Envoy accepted on. */
export interface IngressListener {
  key: string;
  port: number | null;
  requests: number;
  /** Connections that never got a filter chain. See {@link IngressRejection}. */
  rejected: number;
  http: number;
  tcp: number;
  protocols: string[];
  sni: number;
  hosts: number;
  codes: { code: number; class: string; count: number }[];
}

/**
 * A TLS connection turned away before it was routed: `response_code: 0` with
 * `filter_chain_not_found`. It was the single largest failure bucket on the live cluster.
 *
 * These carry no authority at all, so they are grouped by the SNI the client offered — the only
 * identity they have. `sni: null` means none was offered, and that is its own row.
 */
export interface IngressRejection {
  key: string;
  sni: string | null;
  port: number | null;
  count: number;
  clients: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * One `server` entry of an Istio Gateway: the port, protocol and TLS mode it declares.
 *
 * `credentialName` is a **Secret name**. The name is the finding an operator needs ("that Gateway
 * points at a Secret that does not exist"); the value is never read, here or anywhere in
 * `srv/fleet`.
 */
export interface IngressGatewayServer {
  key: string;
  name: string;
  namespace: string;
  selector: Record<string, string> | null;
  port: number | null;
  portName: string | null;
  protocol: string | null;
  tlsMode: string | null;
  credentialName: string | null;
  minProtocolVersion: string | null;
  httpsRedirect: boolean;
  hosts: string[];
}

/** The ingress tier as objects rather than as log lines. Any half can be `null` if unreadable. */
export interface IngressTier {
  pods: {
    total: number;
    running: number;
    ready: number;
    restarts: number;
    namespaces: string[];
    names: string[];
  };
  service: {
    name: string;
    namespace: string;
    type: string | null;
    clusterIP: string | null;
    /** What the provider handed back — a hostname on AWS, an address elsewhere. */
    endpoints: string[];
    ports: {
      name: string | null;
      port: number | null;
      targetPort: string | null;
      nodePort: number | null;
      protocol: string | null;
    }[];
  } | null;
  hpa: {
    name: string;
    namespace: string;
    target: string | null;
    min: number | null;
    max: number | null;
    current: number | null;
    desired: number | null;
    /** True only when both numbers are known. An unknown ceiling is not a ceiling reached. */
    atCeiling: boolean;
    conditions: { type: string | null; status: string | null; reason: string | null; message: string | null }[];
  } | null;
  pdb: {
    name: string;
    namespace: string;
    minAvailable: string | null;
    maxUnavailable: string | null;
    currentHealthy: number | null;
    desiredHealthy: number | null;
    disruptionsAllowed: number | null;
    expectedPods: number | null;
  } | null;
}

/**
 * The same access-log window as {@link TrafficLatency} and {@link TrafficErrorGroup}, scoped to the
 * ingress tier and grouped by the things only the edge sees: the Host header a client sent, the
 * listener it arrived on, the peer that sent it.
 *
 * **`scope` is load-bearing.** `'none'` means no ingress proxy was read — no gateway pod in the
 * cluster, or every one of them refused its log. There is deliberately no fall back to the whole
 * mesh: a sidecar's east-west request under a heading that says ingress is the same class of lie as
 * a 403 rendered as a zero. On `'none'`, every count below is 0 because nothing was measured, and
 * the UI must say so rather than print them.
 */
export interface TrafficIngress {
  scope: 'ingress' | 'none';
  summary: {
    /** How many gateway pods contributed records — the denominator for everything below. */
    ingressProxies: number;
    /** HTTP requests plus TCP connections. */
    records: number;
    requests: number;
    connections: number;
    ok: number;
    redirect: number;
    client: number;
    server: number;
    noResponse: number;
    errors: number;
    /** A share of the ingress records in this window. Deliberately not named a rate. */
    errorShare: number | null;
    /** Distinct **named** hosts. The no-Host-header bucket is excluded — nothing publishes it. */
    hosts: number;
    hostsIncludingUnnamed: number;
    /**
     * Records whose line carried no Host header, as a **record** count.
     *
     * Not derivable from the two counts above: every authority-less record shares one bucket, so
     * `hostsIncludingUnnamed − hosts` is always 0 or 1 however much of the window it represents.
     */
    unnamedRequests: number;
    clients: number;
    externalClients: number;
    /**
     * Peers that sent at least one CONNECT, and peers whose every record was an error.
     *
     * Counted over every peer seen, not the listed rows. The row cap sorts by request volume, so it
     * drops the quietest peers — which is where a scanner is, and what both of these are for.
     */
    clientsConnecting: number;
    clientsFullyRejected: number;
    bytesSent: number | null;
    bytesReceived: number | null;
    total: IngressLatency;
    upstream: IngressLatency;
    overheadMs: number | null;
    ports: { port: number | null; count: number }[];
    byCode: { code: number; class: string; count: number }[];
    rate: IngressRate;
    /** What was configured, so the UI can say "none configured" rather than "none matched". */
    corporateSuffixes: string[];
  };
  /** Request volume per {@link IngressHostGroup}, for the filter chips. */
  groups: { group: IngressHostGroup; requests: number; hosts: number }[];
  hosts: IngressHost[];
  hostsTotal: number;
  hostsTruncated: boolean;
  clients: IngressClient[];
  clientsTotal: number;
  clientsTruncated: boolean;
  flags: IngressFlag[];
  listeners: IngressListener[];
  rejections: IngressRejection[];
  rejectionsTotal: number;
  rejectionsTruncated: boolean;
  gateways: IngressGatewayServer[];
  tier: IngressTier | null;
  ingressProxiesSelected: number;
  /** Gateway pods this read chose and did not get — a 403 or a timeout. Named, never subtracted. */
  ingressProxiesUnread: string[];
  /** How many declaring objects were readable. `null` means that read was refused. */
  routesFrom: { virtualservices: number | null; ingresses: number | null; httproutes: number | null };
  /*
    The classified edge (plan 2026-09-26). Every field below is optional so an older srv still
    type-checks; a screen that finds one absent says "not available from this server", never 0.
  */
  classes?: { rows: EdgeClassRow[]; total: number };
  /** `null` when both the Gateways and the routes reads failed: app traffic cannot be told from the rest. */
  app?: IngressAppTraffic | null;
  certificates?: { items: IngressCertificate[]; unavailable: boolean; reason: string | null };
  dnsEntries?: { items: IngressDnsEntry[]; unavailable: boolean; reason: string | null };
  access?: IngressAccess;
  refused?: IngressRefused;
  envoyFilters?: IngressEnvoyFilters;
  /** `null` = the Services read failed or srv could not build its name index, so the LB DNS is unknown. */
  lb?: IngressLb | null;
  attention?: IngressAttention[];
  /** The Network Path sub-tab. Absent from an older srv. */
  path?: IngressNetworkPath | null;
}

/** An ingress LoadBalancer Service, from its spec, status and annotations. */
export interface PathLoadBalancer {
  service: string;
  /** `Classic Load Balancer` / `Network Load Balancer` on AWS; `null` elsewhere. */
  kind: string | null;
  hostnames: string[];
  ips: string[];
  /** What srv's lookup of `hostnames` returned at read time. */
  resolvedIps: string[];
  resolvedAt: string | null;
  dnsError: string | null;
  proxyProtocol: boolean;
  idleTimeoutSeconds: number | null;
  externalTrafficPolicy: string | null;
  ports: { name: string | null; port: number; targetPort: number | string | null; nodePort: number | null; protocol: string }[];
}

/** Whether each source behind `destinations` was read; anything but `ok` makes an empty list unknown. */
export interface PathDestinationSources {
  networkPolicies: 'ok' | 'unavailable' | 'not-read';
  pipelines: 'ok' | 'unavailable' | 'not-read';
  lbDns: 'ok' | 'partial';
}

/** A destination the name index knows, and the objects that name it. */
export interface PathDestination {
  display: string;
  label: string;
  source: string;
  ips: string[];
  objects: string[];
}

/** An external upstream the sidecar sample reached. `ip` is a destination, never a client. */
export interface PathObservedEgress {
  ip: string;
  display: string | null;
  source: string | null;
  requests: number;
  callers: string[];
  callersTotal: number;
}

/**
 * How a request enters and a connection leaves, hop by hop, each from the object declaring it.
 * A `null` is a read that failed; it is never a zero.
 */
export interface IngressNetworkPath {
  cluster: {
    provider: string | null;
    region: string | null;
    zones: string[];
    domain: string | null;
    shootName: string | null;
    nodeCidr: string | null;
    podCidr: string | null;
    serviceCidr: string | null;
    /** `kube-system/shoot-info` was not read; `reason` says why (`NOT_FOUND` when it does not exist). */
    unavailable: boolean;
    reason: string | null;
  };
  ingress: {
    dns: { name: string; dnsName: string; targets: string[]; ready: boolean | null }[] | null;
    loadBalancers: PathLoadBalancer[];
    servicesUnavailable?: boolean;
    gatewayPods: { total: number; ready: number; nodes: number; zones: string[] } | null;
    nodes: { total: number; zones: string[] } | null;
    proxyProtocolFilter: boolean | null;
    policies: { namespace: string; name: string; action: string | null }[] | null;
    /** `null` = the Gateways read failed. */
    servers: number | null;
    tlsServers?: number | null;
    /** `null` = the VirtualServices, Ingresses or HTTPRoutes read failed. */
    routes: number | null;
  };
  egress: {
    natIps: string[] | null;
    natCidrs?: string[] | null;
    egressGateway: boolean | null;
    serviceEntries: number | null;
    outboundPolicy: string | null;
    destinations: PathDestination[];
    /** How each naming source was read; `null` when srv could not say. Absent from an older srv. */
    destinationSources?: PathDestinationSources | null;
    observed: PathObservedEgress[] | null;
  };
  envoyFilters?: { istioVersion: string | null };
}

/** `GET /api/status`: what this deployment is. Deliberately carries nothing from the app config. */
export interface AppStatusResponse {
  ok: boolean;
  version: string;
  /** Registered clusters; `null` when the server was started without a registry. */
  clusters: number | null;
  authMode: 'oidc' | 'none';
}

export interface TrafficData extends CollectorCluster {
  accessLog: AccessLogVerdict;
  window: TrafficWindow;
  /** Every record in the window, grouped three ways. See {@link TrafficLatency}. */
  latency: TrafficLatency;
  /** The same window, scoped to the edge. See {@link TrafficIngress}. */
  ingress: TrafficIngress;
  summary: {
    requests: number;
    errors: number;
    server: number;
    client: number;
    noResponse: number;
    groups: number;
    byCode: { code: number; class: string; count: number }[];
  } & Completeness;
  errors: TrafficErrorGroup[];
  collectedAt: string;
}
