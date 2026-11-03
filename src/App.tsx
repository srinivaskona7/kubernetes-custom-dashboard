import { Suspense, lazy, useCallback, useState, type CSSProperties } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api } from './api';
import { Rail, useSidebarWidth } from './components/layout';
import { PodLogsProvider } from './components/pod-logs';
import { useAsync } from './useAsync';
import { Skeleton } from './components/ui';
import Overview from './pages/Overview';
/*
 * Every route except the landing one, loaded when it is first visited.
 *
 * `Overview` stays eager because it is what `/` renders: deferring the page the operator always sees
 * first would buy nothing and cost a round trip. The rest are each a real page — `ClusterDetail` alone
 * is the twelve cluster tabs and their tables — and an operator who opens the fleet list and clicks one
 * cluster should not have paid for the onboarding forms, the drift matrix and the Helm release page on
 * the way in.
 *
 * Cluster *tabs* are split a second time inside `ClusterDetail`, which is where most of its weight is.
 */
const Drift = lazy(() => import('./pages/Drift'));
const Tokens = lazy(() => import('./pages/Tokens'));
const Status = lazy(() => import('./pages/Status'));
const ClusterDetail = lazy(() => import('./pages/ClusterDetail'));
const OnboardPage = lazy(() => import('./pages/OnboardPage'));
const OnboardSsoPage = lazy(() => import('./pages/OnboardSsoPage'));
const HelmReleasePage = lazy(() => import('./pages/HelmReleasePage'));
const NotFound = lazy(() => import('./pages/NotFound'));

export default function App() {
  const me = useAsync(useCallback(() => api.me(), []));
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  // The shell owns the width so the grid track and the sidebar's own rendering can never
  // disagree; `Rail` reads it and the handle inside it writes it. See `.app-shell` in theme.css.
  const sidebar = useSidebarWidth();

  return (
    <div className="app-shell" style={{ '--sidebar-w': `${sidebar.width}px` } as CSSProperties}>
      {/* Inside the shell, not around it: the bottom log drawer is `position: fixed` but reads
          `--sidebar-w` to clear the rail, and that custom property is declared here. `PodLogsProvider`
          renders no DOM of its own, so the grid still has exactly its two tracks. */}
      <PodLogsProvider>
        <Rail user={me.data?.name || me.data?.id || null} refreshedAt={refreshedAt} sidebar={sidebar} />
        {/* `min-w-0` is not decoration: the grid track is `minmax(0, 1fr)`, and without this the
            main element's own `min-width: auto` would re-introduce exactly the overflow the track
            exists to prevent. */}
        <main className="flex min-w-0 flex-1">
        {/* One boundary for every route. The skeleton is the same one a page shows while its own read
            is in flight, so a first visit reads as one wait rather than a flash of empty shell. */}
        <Suspense fallback={<Skeleton rows={8} />}>
        <Routes>
          <Route path="/" element={<Overview onRefreshed={setRefreshedAt} />} />
          <Route path="/clusters" element={<Navigate to="/" replace />} />
          <Route path="/onboard" element={<OnboardPage onRefreshed={setRefreshedAt} />} />
          {/* The SSO path is its own page, not a section of /onboard: it needs a callback URI
              registered on the identity provider by an administrator, which the token path does
              not. The server's OIDC callback redirects back here by this exact path. */}
          <Route path="/onboard/advanced" element={<OnboardSsoPage onRefreshed={setRefreshedAt} />} />
          <Route path="/clusters/:id" element={<ClusterDetailRoute onRefreshed={setRefreshedAt} />} />
          {/* A release is a subject with its own page, not a panel inside the cluster's Helm
              section — so it is linkable, and its manifest is not sitting below a table. Keyed
              on all three params for the same reason ClusterDetail is keyed on the cluster:
              moving release→release must remount, never reuse the previous release's state. */}
          <Route
            path="/clusters/:id/helm/:namespace/:name"
            element={<HelmReleaseRoute onRefreshed={setRefreshedAt} />}
          />
          <Route path="/drift" element={<Drift onRefreshed={setRefreshedAt} />} />
          <Route path="/tokens" element={<Tokens onRefreshed={setRefreshedAt} />} />
          <Route path="/status" element={<Status onRefreshed={setRefreshedAt} />} />
          {/* Last, and a real page rather than a `<Navigate to="/">`. An unmatched path used to
              render the shell with an empty content region, which in a console that treats
              "no data" as a meaningful state is indistinguishable from a cluster that returned
              nothing. Redirecting silently to the Overview would have been worse still: it
              hides the broken link instead of naming it. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
        </main>
      </PodLogsProvider>
    </div>
  );
}

export interface PageProps {
  onRefreshed: (at: string) => void;
}

/**
 * Keys `ClusterDetail` on the cluster id so a cluster→cluster move remounts the page.
 *
 * A different cluster is a different *subject*, not fresh data for the same one, and React
 * Router reuses a mounted element when only the param changes. The collapsed rail's cluster
 * dots made that move reachable without leaving the route for the first time — and the page
 * kept the previous cluster's header, node table, capacity bars and token countdown for up to
 * a full poll interval, while the URL and the highlighted dot said otherwise. Worse, tabs that
 * mount their own fetcher (`CapacitySection`) did read the new cluster, so one screen could
 * show cluster A's nodes above cluster B's headroom with nothing saying so.
 *
 * The `key` argument on every per-cluster `useAsync` is the second half of this fix; this
 * remount is the structural guarantee that no state can outlive the subject it describes.
 */
function ClusterDetailRoute({ onRefreshed }: PageProps) {
  const { id = '' } = useParams();
  return <ClusterDetail key={id} onRefreshed={onRefreshed} />;
}

function HelmReleaseRoute({ onRefreshed }: PageProps) {
  const { id = '', namespace = '', name = '' } = useParams();
  return <HelmReleasePage key={`${id}/${namespace}/${name}`} onRefreshed={onRefreshed} />;
}
