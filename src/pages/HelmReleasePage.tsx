/**
 * One Helm release, as its own page.
 *
 * It used to be a card that unfolded underneath the release table. That worked while a release
 * was a handful of fields, and stopped working once it grew a rendered manifest, the chart source,
 * a live resource set and a dependency graph: the interesting content sat below a full-height
 * table you had to scroll past every time, and the URL still said "the Helm section of the
 * cluster", so nobody could link a colleague to a release. A release is a subject, so it gets a
 * route.
 *
 * ## Seven tabs, and the questions they answer in order
 *
 *   Insights       is this release healthy, and what should I look at first
 *   Resources      what is actually running, and what proves it belongs to this release
 *   Architecture   how those objects depend on each other
 *   Values         what this was configured with, at four levels of "configured"
 *   Manifest       the YAML Helm rendered, and the chart it rendered from
 *   History        the revision timeline, and what changed between two revisions
 *   Events         what the cluster has said about these objects recently
 *
 * Insights is the default because the first question is never "show me YAML".
 *
 * ## Two fetches, and which tabs pay for which
 *
 * The cluster's release list (`/helm/releases`) is fetched by the shell: it carries the release
 * identity, its stored values, its revisions and the per-pane capability verdicts, so every tab
 * needs it. The live set (`/helm/related`) is fetched by `LiveTabs`, which mounts only for the
 * four tabs that draw live objects — that is what makes "only the mounted tab fetches" a
 * structural property rather than a condition someone has to remember. Landing straight on this
 * URL works either way; no state is handed over from a table the operator may never have visited.
 *
 * ## When Helm's storage cannot be read
 *
 * Values, Manifest and History come out of the stored release record and die together when it is
 * unreadable — each says so in its own sentence, naming what an admin has to grant. The four live
 * tabs keep working, because live inspection is a different read with different RBAC. Nothing here
 * is ever inferred from live resource labels to fill the hole: that would be inventing a history
 * no record supports.
 *
 * ## Read-only
 *
 * There is no rollback, no upgrade, no uninstall and no edit anywhere on this page or under it.
 * Everything shown is redacted server-side: a rendered Secret keeps its keys and loses every
 * value. See srv/fleet/collectors/helm.js.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type Capability, type HelmData, type HelmRelease } from '../api';
import { PageHeader } from '../components/layout';
import { Empty, ErrorState, Pill, Skeleton } from '../components/ui';
import { UnavailableNotice, envelopeScope } from '../components/unavailable';
import { CapabilityEmpty, CapabilityNotice } from '../capability';
import { SubTabs } from '../components/SubTabs';
import { ago } from '../format';
import { useAsync } from '../useAsync';
import type { PageProps } from '../App';
import { endpointTitle, resolveAccessEndpoint, type AccessEndpoint } from './helm/access-endpoint';
import { HelmEvents } from './helm/HelmEvents';
import { HelmHistory } from './helm/HelmHistory';
import { HelmInsights } from './helm/HelmInsights';
import { HelmManifest } from './helm/HelmManifest';
import { HelmResourceDrawer } from './helm/HelmResourceDrawer';
import { HelmResources, type ResourceFilters } from './helm/HelmResources';
import { HelmValues } from './helm/HelmValues';
import { statusTone } from './helm/shared';

/**
 * The graph, loaded on demand.
 *
 * The only lazy boundary on this page, and the only one it needs: the graph is the single largest
 * component here and the tab most operators never open. Everything else is a table or a code pane
 * whose cost is the payload, not the code.
 */
const HelmArchitecture = lazy(() => import('./helm/HelmArchitecture'));

const TABS = [
  { id: 'insights', label: 'Insights' },
  { id: 'resources', label: 'Resources' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'values', label: 'Values' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'history', label: 'History' },
  { id: 'events', label: 'Events' }
] as const;

type TabId = (typeof TABS)[number]['id'];

/** The tabs drawn from the live cluster read, rather than from Helm's stored record. */
type LiveTabId = 'insights' | 'resources' | 'architecture' | 'events';
const LIVE_TABS = new Set<TabId>(['insights', 'resources', 'architecture', 'events']);
const isLive = (tab: TabId): tab is LiveTabId => LIVE_TABS.has(tab);

const FILTER_DEFAULTS: ResourceFilters = { q: '', kind: 'all', group: 'all', relationship: 'all' };

/**
 * The open tab, in the URL.
 *
 * `?htab=` rather than `useState`, for the reason every other place in this console is a URL: a
 * tab is a place, and a place has to survive a refresh, a copied link and the back button.
 * `replace: true` because Back should leave the release, not walk its seven tabs.
 */
function useReleaseTab(): [TabId, (next: TabId) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('htab');
  const active = (TABS.find(t => t.id === raw)?.id ?? 'insights') as TabId;

  const set = useCallback(
    (next: TabId) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          p.set('htab', next);
          // The detail panel exists only on the four live tabs. A selection carried into Values
          // would describe something not on screen, so it is dropped on the way out and kept on a
          // move between live tabs, where it still resolves.
          if (!LIVE_TABS.has(next)) p.delete('rsel');
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  return [active, set];
}

/** The Resources tab's four filters, in the URL so a filtered view is a link. */
function useResourceFilters(): [ResourceFilters, (next: Partial<ResourceFilters>) => void] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(
    () => ({
      q: params.get('hq') ?? FILTER_DEFAULTS.q,
      kind: params.get('hkind') ?? FILTER_DEFAULTS.kind,
      group: params.get('hgroup') ?? FILTER_DEFAULTS.group,
      relationship: params.get('hrel') ?? FILTER_DEFAULTS.relationship
    }),
    [params]
  );

  const set = useCallback(
    (next: Partial<ResourceFilters>) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          const keys: [keyof ResourceFilters, string][] = [
            ['q', 'hq'],
            ['kind', 'hkind'],
            ['group', 'hgroup'],
            ['relationship', 'hrel']
          ];
          for (const [field, param] of keys) {
            const value = next[field];
            if (value === undefined) continue;
            // A filter back at its default is absent from the URL rather than spelled out — the
            // link an operator copies should carry what they changed, not the whole form.
            if (value === FILTER_DEFAULTS[field]) p.delete(param);
            else p.set(param, value);
          }
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  return [filters, set];
}

/** The selected related resource, in the URL. `rsel` — the page's own key, not the cluster `res`. */
function useSelectedResource(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const selected = params.get('rsel');

  const set = useCallback(
    (id: string | null) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          if (id) p.set('rsel', id);
          else p.delete('rsel');
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  return [selected, set];
}

/**
 * Where this release answers, beside the chips that say what it is.
 *
 * ## Why it is worth a pill
 *
 * "What is the URL" is the first question anyone asks about a deployed release and the last thing
 * the console could answer: the host sits in one field of one Ingress or HTTPRoute, four clicks down the
 * Resources tab, inside a fact list. It is an identity fact, so it belongs beside the chart version.
 *
 * ## The host is read; the scheme is not
 *
 * `resolveAccessEndpoint` reads the first host off an Ingress or HTTPRoute in the
 * release's live set. Nothing in a manifest states `http` or `https`, so the `https://` in the href
 * is this console's assumption and the label says `assumed` in as many words rather than letting a
 * rendered scheme imply a field. A host that is a wildcard pattern gets no link at all: it is not
 * an address, and an href built from one goes nowhere.
 *
 * ## The copy button copies
 *
 * It writes to the clipboard and calls nothing. This page is read-only, and the reason to copy is
 * that the next step is a `curl` in a terminal.
 */
function AccessEndpointPill({ endpoint }: { endpoint: AccessEndpoint }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(endpoint.url ?? endpoint.host).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      // A refused clipboard write (no permission, insecure context) says nothing rather than
      // claiming a copy that did not happen.
      () => setCopied(false)
    );
  };

  const title = endpointTitle(endpoint);

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 py-0.5 pl-2.5 pr-1 text-[12px]">
      <span className="text-muted">endpoint</span>
      {endpoint.url ? (
        <a
          href={endpoint.url}
          target="_blank"
          rel="noreferrer"
          title={title}
          className="mono max-w-[38ch] truncate text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {endpoint.host}
        </a>
      ) : (
        <span className="mono max-w-[38ch] truncate text-text" title={title}>
          {endpoint.host}
        </span>
      )}
      <span className="text-muted/70" title={title}>
        {endpoint.url ? 'https assumed' : 'pattern, not an address'}
      </span>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${endpoint.url ?? endpoint.host} to the clipboard. Copies text; calls nothing.`}
        className="rounded-full px-1.5 text-muted transition-colors hover:text-accent"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

export default function HelmReleasePage({ onRefreshed }: PageProps) {
  const { id = '', namespace = '', name = '' } = useParams();
  const [tab, setTab] = useReleaseTab();
  const [filters, setFilters] = useResourceFilters();
  const [selected, setSelected] = useSelectedResource();

  /**
   * The access endpoint, reported up from the live read rather than fetched again here.
   *
   * It is a fact about the release's routes, and the only payload carrying that is `/related` —
   * which `LiveTabs` fetches for the four live tabs and nothing else. Hoisting that fetch to the
   * shell to fill a header pill would make every Values or Manifest visit pay for a forty-resource
   * live read, which is the one structural property this page is built around.
   *
   * So: no pill until a live tab has answered, and none at all on a release with no route host.
   * The key pins the answer to the release it came from, so navigating between two releases cannot
   * leave the first one's hostname over the second one's name.
   */
  const releaseKey = `${id}/${namespace}/${name}`;
  const [reported, setReported] = useState<{ key: string; value: AccessEndpoint | null } | null>(null);
  const onEndpoint = useCallback(
    (value: AccessEndpoint | null) => setReported({ key: releaseKey, value }),
    [releaseKey]
  );
  const endpoint = reported?.key === releaseKey ? reported.value : null;

  const { data, error, initial, fetchedAt } = useAsync(
    useCallback(() => api.clusterHelmReleases(id), [id]),
    0,
    id
  );

  /** `fetchedAt` is an epoch; everything that prints a time in this console takes an ISO string. */
  const readAt = fetchedAt ? new Date(fetchedAt).toISOString() : null;

  // The shell's freshness indicator, fed from the read rather than from a button press. The global
  // Refresh control is gone: it invited an operator to believe a page was stale whenever they had
  // not clicked it, and every pane here already says when its own data was collected.
  useEffect(() => {
    if (readAt) onRefreshed(readAt);
  }, [readAt, onRefreshed]);

  const d = data?.ok ? data.data : null;
  const release = d?.releases.find(r => r.namespace === namespace && r.name === name) ?? null;

  const goToResources = useCallback(
    (group?: string) => {
      setTab('resources');
      setFilters({ group: group ?? FILTER_DEFAULTS.group });
    },
    [setTab, setFilters]
  );

  const crumb = (
    <span className="mono text-[13px]">
      <Link to="/" className="text-muted transition-colors hover:text-accent">
        Fleet
      </Link>
      <span className="px-1.5 text-muted/50">/</span>
      <Link to={`/clusters/${encodeURIComponent(id)}`} className="text-muted transition-colors hover:text-accent">
        {id}
      </Link>
      <span className="px-1.5 text-muted/50">/</span>
      <Link
        to={`/clusters/${encodeURIComponent(id)}?tab=helm`}
        className="text-muted transition-colors hover:text-accent"
      >
        Helm Releases
      </Link>
      <span className="px-1.5 text-muted/50">/</span>
      <span className="text-muted">{namespace}</span>
      <span className="px-1.5 text-muted/50">/</span>
      <span className="text-text">{name}</span>
    </span>
  );

  /**
   * One metadata line, not a grid of cards.
   *
   * Namespace, chart, chart version, app version, revision, when it was last deployed and when
   * this console read it — the seven facts that identify a release. They used to be three Sections
   * of `Field`s, which pushed the actual content below the fold on a laptop to say what fits on
   * one line.
   */
  const metadata = release ? (
    <span className="mono flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span>{release.namespace}</span>
      <span className="text-muted/50">·</span>
      <span>{release.chart.name ?? 'chart not recorded'}</span>
      <span className="text-muted/50">·</span>
      <span>chart {release.chart.version ?? '—'}</span>
      <span className="text-muted/50">·</span>
      <span>app {release.chart.appVersion ?? '—'}</span>
      <span className="text-muted/50">·</span>
      <span>revision {release.revision ?? '—'}</span>
      <span className="text-muted/50">·</span>
      <span title={release.lastDeployed ?? undefined}>
        deployed {release.lastDeployed ? ago(release.lastDeployed) : 'not recorded'}
      </span>
      <span className="text-muted/50">·</span>
      <span title={readAt ?? undefined}>read {readAt ? ago(readAt) : '—'}</span>
    </span>
  ) : (
    <span className="mono text-[13px]">
      {namespace} · {id}
    </span>
  );

  let body: JSX.Element;
  if (initial) body = <Skeleton rows={8} />;
  // `!data` before `error`, deliberately: `useAsync` keeps the last good payload across a failed
  // refresh, and testing `error` first threw it away. An operator reading a release, clicking into
  // a tab and hitting a session lapse would watch the whole page collapse into an error card. The
  // failure is reported as a banner over content that is still true.
  else if (!data) body = <ErrorState code={error!.code} message={error!.message} />;
  else if (!data.ok && data.error)
    body = (
      <ErrorState cluster={id} code={data.error.code} message={data.error.message} needsReseed={data.error.needsReseed} />
    );
  else if (!release && d && d.capabilities.releases.trusted)
    body = (
      <Empty
        title="No such release"
        // Says which of the two it is. A release that was uninstalled and a namespace that was
        // mistyped are different problems, and the page cannot tell them apart — so it says so
        // rather than guessing. Reached only when the store was readable, so the absence is real.
        hint={`Helm's release store on ${id} is readable and holds no release named "${name}" in namespace "${namespace}". It was uninstalled, or the link is stale.`}
      />
    );
  else
    body = (
      <ReleaseTabs
        clusterId={id}
        namespace={namespace}
        name={name}
        release={release}
        capabilities={d!.capabilities}
        tab={tab}
        onTab={setTab}
        filters={filters}
        onFilters={setFilters}
        selected={selected}
        onSelect={setSelected}
        onGoToResources={goToResources}
        onEndpoint={onEndpoint}
      />
    );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="page-x pt-5">{crumb}</div>
      <PageHeader
        title={name}
        icon="helm"
        info="Decoded from this release's Helm Secrets (owner=helm) in the cluster \u2014 revisions, chart and app versions, the rendered manifest and its values. Values are masked: a key is shown, a credential never is."
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {release && <Pill tone={statusTone(release.status)}>{release.status ?? 'unknown'}</Pill>}
            {endpoint && <AccessEndpointPill endpoint={endpoint} />}
            {metadata}
          </span>
        }
      />

      <div className="min-w-0 flex-1 space-y-4 page-x py-4">
        {/* A refresh that failed over data that is still on screen. Silently keeping the old
            payload would let an operator act on a stale reading believing it is current. */}
        {error && data && (
          <div className="rounded-[8px] border border-warn/40 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
            <strong className="font-semibold">This did not refresh.</strong> {error.message} Everything below is the
            last reading that succeeded, not the cluster as it is now.
          </div>
        )}
        {d && <UnavailableNotice scope={envelopeScope(id, d.summary)} />}
        {/* The store's own verdict, once, above the tabs — the three record-derived tabs each
            repeat it in their own words, but an operator should not have to open one to find out
            why the release itself is thin. */}
        {d && <CapabilityNotice capability={d.capabilities.releases} />}
        {body}
      </div>
    </div>
  );
}

/**
 * The tab strip and whichever tab is open.
 *
 * `release` is nullable on purpose: when Helm's store is unreadable there is no stored record to
 * find, and the four live tabs must still work — the release's identity comes from the URL, not
 * from the store. The three record-derived tabs render their capability sentence instead.
 */
function ReleaseTabs({
  clusterId,
  namespace,
  name,
  release,
  capabilities,
  tab,
  onTab,
  filters,
  onFilters,
  selected,
  onSelect,
  onGoToResources,
  onEndpoint
}: {
  clusterId: string;
  namespace: string;
  name: string;
  release: HelmRelease | null;
  capabilities: HelmData['capabilities'];
  tab: TabId;
  onTab: (next: TabId) => void;
  filters: ResourceFilters;
  onFilters: (next: Partial<ResourceFilters>) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onGoToResources: (group?: string) => void;
  onEndpoint: (endpoint: AccessEndpoint | null) => void;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <SubTabs
        sections={TABS}
        active={tab}
        onSelect={onTab}
        // Only History's count is known before its tab is opened, and only it means one thing.
        // A `resources` count from the stored manifest would not be the number the Resources tab
        // then shows — that tab counts live objects, which is a different set on purpose.
        counts={release ? { history: release.revisionCount } : undefined}
      />

      {isLive(tab) ? (
        <LiveTabs
          clusterId={clusterId}
          namespace={namespace}
          name={name}
          tab={tab}
          capability={capabilities.liveInspection}
          filters={filters}
          onFilters={onFilters}
          selected={selected}
          onSelect={onSelect}
          onGoToResources={onGoToResources}
          onEndpoint={onEndpoint}
        />
      ) : !release ? (
        <CapabilityEmpty
          capability={
            tab === 'values' ? capabilities.values : tab === 'manifest' ? capabilities.manifest : capabilities.history
          }
        />
      ) : tab === 'values' ? (
        <HelmValues clusterId={clusterId} release={release} capability={capabilities.values} />
      ) : tab === 'manifest' ? (
        <HelmManifest clusterId={clusterId} release={release} capability={capabilities.manifest} />
      ) : (
        <HelmHistory clusterId={clusterId} release={release} capability={capabilities.history} />
      )}
    </div>
  );
}

/**
 * The four tabs that read the live cluster, and the one fetch behind them.
 *
 * Mounted only for those tabs, so opening Values or Manifest costs no live read at all — and a
 * move between the four reuses one payload rather than fetching per tab. The detail panel lives
 * here too, because this is where the resources it describes are: `HelmResourceDrawer` renders
 * from the `/related` payload rather than through `ResourceDataProvider`, which is mounted only on
 * `ClusterDetail`. A `<ResourceLink>` on this route would set `?res=` with nothing on screen able
 * to answer it; the drawer's own "view live resource" link goes to the cluster page instead, which
 * knows how to land on a Kind's home tab.
 */
function LiveTabs({
  clusterId,
  namespace,
  name,
  tab,
  capability,
  filters,
  onFilters,
  selected,
  onSelect,
  onGoToResources,
  onEndpoint
}: {
  clusterId: string;
  namespace: string;
  name: string;
  tab: LiveTabId;
  capability: Capability;
  filters: ResourceFilters;
  onFilters: (next: Partial<ResourceFilters>) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onGoToResources: (group?: string) => void;
  onEndpoint: (endpoint: AccessEndpoint | null) => void;
}): JSX.Element {
  const { data, error, initial } = useAsync(
    useCallback(() => api.clusterHelmRelated(clusterId, namespace, name), [clusterId, namespace, name]),
    0,
    `${clusterId}/${namespace}/${name}`
  );

  /**
   * Hand the header its endpoint, before any of the early returns below.
   *
   * `null` is reported as deliberately as a host is: a release whose route lost its host, or whose
   * live read failed, must clear the pill rather than leave the previous reading in the header —
   * a stale hostname beside a live status is the page contradicting itself.
   */
  const endpoint = useMemo(
    () => (data?.ok && data.data ? resolveAccessEndpoint(data.data.resources) : null),
    [data]
  );
  useEffect(() => {
    onEndpoint(endpoint);
  }, [endpoint, onEndpoint]);

  if (initial) return <Skeleton rows={8} />;
  if (!data) return <ErrorState code={error!.code} message={error!.message} />;
  // `ok` and `data` are independent fields on the envelope, not a discriminated union, so an `ok`
  // response with no payload is representable and has to be handled rather than asserted away.
  const payload = data.ok ? data.data : undefined;
  if (!payload) {
    return data.error ? (
      <ErrorState cluster={clusterId} code={data.error.code} message={data.error.message} needsReseed={data.error.needsReseed} />
    ) : (
      <CapabilityEmpty capability={capability} />
    );
  }

  const scope = envelopeScope(clusterId, payload.summary);
  const resource = selected ? payload.resources.find(r => r.id === selected) ?? null : null;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-[8px] border border-warn/40 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
          <strong className="font-semibold">The live read did not refresh.</strong> {error.message} What follows is the
          last reading that succeeded.
        </div>
      )}
      <UnavailableNotice scope={scope} />
      <CapabilityNotice capability={capability} />

      <div className="flex min-w-0 items-start gap-4">
        <div className="min-w-0 flex-1">
          {tab === 'insights' ? (
            <HelmInsights
              clusterId={clusterId}
              data={payload}
              scope={scope}
              onSelectResource={onSelect}
              onGoToResources={onGoToResources}
            />
          ) : tab === 'resources' ? (
            <HelmResources
              data={payload}
              filters={filters}
              onFilters={onFilters}
              selected={selected}
              onSelect={onSelect}
            />
          ) : tab === 'architecture' ? (
            <Suspense fallback={<Skeleton rows={10} />}>
              <HelmArchitecture data={payload} selected={selected} onSelectResource={onSelect} />
            </Suspense>
          ) : (
            <HelmEvents data={payload} onSelectResource={onSelect} />
          )}
        </div>

        {resource && (
          <HelmResourceDrawer clusterId={clusterId} resource={resource} onClose={() => onSelect(null)} />
        )}
      </div>

      {/* A selection that no longer resolves — a resource that has gone, or a hand-edited link.
          Said out loud rather than silently ignored, because an empty drawer slot next to a
          populated URL reads as a broken page. */}
      {selected && !resource && (
        <p className="text-[13px] text-warn">
          <span className="mono">{selected}</span> is not in this release&apos;s live set, so there is nothing to open.
          It may have been deleted since the link was made.
        </p>
      )}
    </div>
  );
}
