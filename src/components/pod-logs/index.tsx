/**
 * `openPodLogs()` — the one way anything in this console shows a pod's log.
 *
 * Mounted once, in the app shell. Every Logs action anywhere — a node's scheduled pods, the
 * workload pod list, Top Utilization, the resource drawer's investigation links — calls
 * `openPodLogs({ cluster, namespace, pod })` and gets the same drawer, reading through the same
 * `usePodLogTail`. There is deliberately no second log implementation to keep in step, and no
 * surface that shows a Logs button over data it cannot actually read.
 *
 * Two behaviours belong here rather than in the drawer, because they are about the *session* rather
 * than about one open drawer:
 *
 *  1. **A route change closes it.** The drawer is scoped to a cluster and a pod. Leaving the page
 *     that opened it means that pod is no longer what the operator is looking at, and a drawer still
 *     reading it would poll a cluster the screen no longer names. `Open in Live Pod Logs` navigates,
 *     so this is also what closes it on the way out.
 *  2. **Opening a second pod replaces the first.** One drawer, not a stack: two bottom drawers cannot
 *     both be at the bottom, and a stack would hide the older one behind the newer with no way back.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import * as prefetch from '../../prefetch';
import { PodLogsDrawer, type PodLogTarget } from './PodLogsDrawer';

export interface PodLogsApi {
  /** Show this pod's log in the bottom drawer. Never navigates; never touches the URL. */
  openPodLogs: (target: PodLogTarget) => void;
  /**
   * Warm the read the drawer will make, for a pointer resting on a Logs button.
   *
   * The drawer needs `/clusters/:id/pods` for the container list, which is already 4th in the
   * prefetch sweep — so on a cluster page this is usually a no-op against a warm entry. It matters
   * on the fleet Overview and the Helm release route, which never sweep that cluster.
   */
  warmPodLogs: (cluster: string) => void;
  /** Which pod is open, or null. Lets a table mark the row it is showing. */
  openTarget: PodLogTarget | null;
}

const Ctx = createContext<PodLogsApi | null>(null);

export function PodLogsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [target, setTarget] = useState<PodLogTarget | null>(null);
  const { pathname } = useLocation();

  // Keyed on `pathname` alone, not on the whole location: the query string is where this console
  // keeps tab and filter state, and closing the drawer every time a namespace filter is written
  // would make it unusable on precisely the pages it exists for.
  useEffect(() => {
    setTarget(null);
  }, [pathname]);

  const api = useMemo<PodLogsApi>(
    () => ({
      openPodLogs: t => setTarget(t),
      warmPodLogs: cluster => prefetch.warm(`/clusters/${cluster}/pods`),
      openTarget: target
    }),
    [target]
  );

  const close = useCallback(() => setTarget(null), []);

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Keyed on the pod, so switching pods remounts: the viewer's scroll anchoring, the container
          selection and the local tail/filter state all belong to one pod, and carrying them across
          would open pod B on pod A's filter with no indication why. */}
      {target && (
        <PodLogsDrawer key={`${target.cluster}/${target.namespace}/${target.pod}`} target={target} onClose={close} />
      )}
    </Ctx.Provider>
  );
}

/**
 * The accessor. Throws rather than degrading: a Logs button whose handler silently did nothing is
 * exactly the dead control this work exists to remove, and a missing provider is a wiring mistake
 * that must fail loudly in development rather than ship as an inert button.
 */
export function usePodLogs(): PodLogsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePodLogs() outside a <PodLogsProvider>. Mount the provider in the app shell.');
  return ctx;
}

export type { PodLogTarget } from './PodLogsDrawer';
