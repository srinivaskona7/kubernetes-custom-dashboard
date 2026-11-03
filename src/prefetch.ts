/**
 * Speculative tab warming.
 *
 * Measured on platformsbx, cold, one cluster: `traffic-errors` 5.7s, `summary` 3.2s,
 * `security` 2.1s, `pods` 1.3s, `namespaces` 1.0s, the rest under a second. Every one of those
 * numbers is a *first* visit — the server's 30s route cache and 8s list cache make the second
 * visit to the same tab effectively free. So the latency an operator actually feels is almost
 * entirely the cost of being the first to ask, and the fix is to ask before they click.
 *
 * Three properties keep this from being a denial of service against the operator's own cluster:
 *
 *  1. **Serial.** One speculative read is in flight at a time, in the order below. A sweep of
 *     twelve parallel reads would saturate the same eight-slot per-cluster gate the tab in
 *     front of the operator needs, which is the precise inversion the low-priority tier exists
 *     to prevent. Serial also means a foreground caller joining an in-flight prefetch (see
 *     `sharedGet` in api.ts) waits behind one read, never behind a whole sweep.
 *  2. **Low priority.** Every read carries `x-fleet-priority: low`, which the router turns into
 *     `withLowPriority`. That caps speculative work at six of the cluster's eight slots, so an
 *     interactive read always has two waiting for it.
 *  3. **Once per window.** A cluster is swept at most once per `SWEEP_TTL_MS`, which matches
 *     the server's route cache. Sweeping faster only re-reads a cache; sweeping slower is the
 *     point of a cache.
 *
 * It is strictly read-only and adds no route: every path here is one the tab itself would have
 * requested a moment later.
 */
import { DEFAULT_TRACES_TAIL, DEFAULT_TRAFFIC_TAIL, prefetchGet } from './api';
import type { Tab } from './pages/cluster-tabs/tabs';

/** Matches the server's route cache, so a sweep never re-reads its own warm entry. */
export const SWEEP_TTL_MS = 30_000;

/** How long to leave the clicked tab alone with the gate before warming anything else. */
export const HEAD_START_MS = 1_200;

/**
 * Which reads back each tab.
 *
 * Only the *unparameterised* ones. A tab whose read depends on a selection the operator has
 * not made yet — `logs` needs a namespace and a pod, a Helm release page needs a release — is
 * deliberately absent: guessing the selection warms the wrong read and pays for it twice.
 * `logs` still gets its pod inventory, because that is the read it makes before any selection
 * exists.
 */
export const TAB_READS: Record<Tab, (id: string) => string[]> = {
  overview: id => [`/clusters/${id}/overview`, `/clusters/${id}/summary`],
  nodes: id => [`/clusters/${id}/topology`, `/clusters/${id}/capacity`],
  // `/autoscaling` backs the Autoscalers and CronJobs sub-tabs; `/reliability` went with its sub-tab.
  workloads: id => [`/clusters/${id}/workloads`, `/clusters/${id}/events`, `/clusters/${id}/autoscaling`],
  network: id => [
    `/clusters/${id}/traffic-errors?tailLines=${DEFAULT_TRAFFIC_TAIL}`,
    `/clusters/${id}/traces?tailLines=${DEFAULT_TRACES_TAIL}`
  ],
  networking: id => [`/clusters/${id}/networking`],
  istio: id => [`/clusters/${id}/mesh`],
  observability: id => [`/clusters/${id}/observability`],
  certificates: id => [`/clusters/${id}/certificates`],
  storage: id => [`/clusters/${id}/storage`],
  logs: id => [`/clusters/${id}/pods`],
  traffic: () => [],
  security: id => [`/clusters/${id}/security`, `/clusters/${id}/policy`, `/clusters/${id}/opa`],
  platform: id => [`/clusters/${id}/modules`, `/clusters/${id}/btp-services`, `/clusters/${id}/observability`],
  // Retired tab ids remain only so an in-flight legacy selection type-checks; Network Operations
  // owns their reads, so following an old bookmark never starts a duplicate sweep.
  traces: () => [],
  helm: id => [`/clusters/${id}/helm/releases`],
  cost: id => [`/clusters/${id}/cost`],
  tokens: () => []
};

/**
 * Warming order, worst-first — not tab order.
 *
 * The point is to spend the idle window on the reads that would otherwise make the operator
 * wait. Network Operations is first because its edge evidence is slow *every* time: the server
 * deliberately refuses to cache a log tail, so without this its 5.7s is paid on every visit
 * rather than only the first.
 */
export const SWEEP_ORDER: Tab[] = [
  'network',
  'networking',
  'istio',
  'observability',
  'certificates',
  'security',
  'logs',
  'workloads',
  'overview',
  'nodes',
  'helm',
  'platform',
  'storage',
  // Second to last: it reads nodes and pods, which every other sweep entry has already put in
  // the server's cache by the time this runs, so it costs the rate-card arithmetic and nothing else.
  'cost',
  'tokens'
];

/** When each cluster was last swept, so the TTL survives a remount. */
const lastSweep = new Map<string, number>();

/** When each hinted path was last warmed, so a pointer sweeping a table reads it once. */
const lastWarm = new Map<string, number>();

/**
 * Warm one path the operator has signalled they are about to need.
 *
 * The sweep above deliberately skips every *parameterised* read, because guessing a selection
 * warms the wrong one. A pointer resting on a specific row is not a guess — it names the
 * selection — so the two rules are not in tension: the sweep stays blind and unparameterised,
 * and this is only ever called with a path the operator has pointed at.
 *
 * Same three properties as the sweep. Low priority, so it can never take the last two of the
 * cluster's eight slots from the read in front of the operator. Deduped on the same 30s window
 * as the server's route cache, so crossing a table twenty times costs one read, not twenty. And
 * `prefetchGet` never rejects, so a refused read is silent rather than an unhandled rejection.
 */
export function warm(path: string): void {
  const last = lastWarm.get(path);
  if (last !== undefined && Date.now() - last < SWEEP_TTL_MS) return;
  lastWarm.set(path, Date.now());
  void prefetchGet(path);
}

/**
 * The sweep in flight, if any.
 *
 * One at a time across the whole app, keyed by cluster so a second `start` for the *same*
 * cluster is a no-op rather than a cancel-and-restart. Getting that wrong is subtle and was
 * the first version's bug: cancelling on every `start` and then hitting the TTL check meant a
 * tab switch two seconds in killed the sweep and refused to run another for thirty seconds,
 * so the warming quietly stopped happening for exactly the operators who browse fastest.
 */
let active: { clusterId: string; cancelled: boolean } | null = null;

/**
 * Warm every tab of `clusterId` except `skip`, which is loading itself already.
 *
 * Returns a cancel function for the caller's unmount. It only cancels the sweep it started —
 * a later `start` for the same cluster never disturbs a sweep already running.
 */
export function start(clusterId: string, skip: Tab | null): () => void {
  if (!clusterId) return () => {};
  if (active && active.clusterId === clusterId) return () => {};

  const last = lastSweep.get(clusterId);
  if (last !== undefined && Date.now() - last < SWEEP_TTL_MS) return () => {};

  // A sweep for a *different* cluster is stale the moment the operator leaves it.
  if (active) active.cancelled = true;

  const mine = { clusterId, cancelled: false };
  active = mine;

  const timer = setTimeout(async () => {
    // A hidden tab is nobody looking at a dashboard. Warming it spends the operator's cluster
    // budget on a window they cannot see — the same reason useAsync gates its polling.
    if (mine.cancelled || document.visibilityState !== 'visible') {
      if (active === mine) active = null;
      return;
    }
    lastSweep.set(clusterId, Date.now());
    try {
      /*
        One read per *path*, not per tab.

        Tabs legitimately share reads — Top Utilization ranks the workloads payload, Observability
        reads the same access-log tail as Traffic Errors — and before this a shared path was
        fetched once per tab that listed it. The second fetch hits the server's route cache, so it
        looked free; it is not. It is another round trip holding one of the cluster's eight gate
        slots at the exact moment the operator's own tab may want it, which is the inversion the
        low-priority tier exists to prevent. Declaring a shared read in both tabs' `TAB_READS` is
        the honest description of what each tab needs, so the dedupe belongs here.
      */
      const swept = new Set<string>();
      for (const tab of SWEEP_ORDER) {
        if (tab === skip) continue;
        for (const path of TAB_READS[tab](clusterId)) {
          if (mine.cancelled) return;
          if (swept.has(path)) continue;
          swept.add(path);
          // Serial on purpose — see the header. `prefetchGet` never rejects, so one refused
          // read (a tab this reader's role cannot see) does not abandon the rest of the sweep.
          await prefetchGet(path);
        }
      }
    } finally {
      if (active === mine) active = null;
    }
  }, HEAD_START_MS);

  return () => {
    mine.cancelled = true;
    clearTimeout(timer);
    if (active === mine) active = null;
  };
}

/** Test seam: forget every sweep, running or remembered. */
export function reset(): void {
  if (active) active.cancelled = true;
  active = null;
  lastSweep.clear();
  lastWarm.clear();
}
