/**
 * Live Pod Logs — the per-cluster tab, and the only *page-sized* log surface.
 *
 * The cluster is fixed by the enclosing ClusterDetail route (`id` prop), so there is no cluster
 * picker: no `api.clusters()` call, no `cluster` query param read or written here. What survives is
 * the deep link into a specific namespace/pod/container: `ns`/`pod`/`container` (plus
 * `previous`/`tail`/`dir`/`level`) live in the URL via `useSearchParams`, so a link built elsewhere
 * as `?tab=logs&ns=…&pod=…&container=…` lands on the right log the moment this tab mounts. That is
 * what the bottom drawer's "Open in Live Pod Logs" uses.
 *
 * The reading itself is **not implemented here**. `usePodLogTail`, `PodLogsControls` and
 * `PodLogsViewer` in `components/pod-logs/` are shared with the drawer, so there is one reader, one
 * control row and one scroller in the whole console. This file owns exactly two things the drawer
 * does not have: the cluster-wide pod list on the left, and the URL as the store for the selection.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type LogPod } from '../../api';
import { Btn, Dot, Empty, ErrorState, Pill, Skeleton } from '../../components/ui';
import { PodLogsControls } from '../../components/pod-logs/PodLogsControls';
import { PodLogsViewer } from '../../components/pod-logs/PodLogsViewer';
import { usePodLogTail } from '../../components/pod-logs/use-pod-log-tail';
import { DEFAULT_LEVEL_FLOOR, isLevelFloor } from '../../components/pod-logs/level';
import { ago } from '../../format';
import { seedCommand } from '../../status';
import { useAsync } from '../../useAsync';
import { DEFAULT_LOG_DIRECTION, isLogDirection, orderPods } from './log-pods';

/**
 * The pod list is always read worst-first, and the order is no longer a control.
 *
 * It was a three-way select (`Newest first / Problems first / Name`) next to the namespace filter.
 * Two selects side by side reads as two filters, and only one of them filtered — the second merely
 * reordered the same rows, which is a distinction a dense header does not make visible. It is gone,
 * and the fixed order is the one the tab's own empty-state text already promised and every other pod
 * list in this console uses: a pod with a bad phase first, then one with restarts, then the rest
 * alphabetically. That is triage order, which is why this tab gets opened.
 *
 * `orderPods` still accepts the other two and their tests still cover them — the capability is
 * intact, it is simply not a control the operator has to make a decision about.
 */
const POD_LIST_ORDER = 'problems' as const;

export default function LogsTab({ id }: { id: string }): JSX.Element {
  const [params, setParams] = useSearchParams();

  // `ns` is the *selected pod's* namespace, not the list filter — the two were one param, and that
  // is why opening the tab cold showed a single pod: auto-selecting a pod wrote its namespace to
  // `ns`, which the list then filtered on, collapsing a 200-pod cluster-wide list to one namespace
  // the operator never chose. `filterNs` is the filter, and its absence means all namespaces.
  // Existing `?ns=…&pod=…` deep links keep working unchanged and now land with the full list around
  // the pod they name, which is strictly more useful than landing in a list of one.
  const namespace = params.get('ns') ?? '';
  const filterNs = params.get('filterNs') ?? '';
  const podName = params.get('pod');
  const container = params.get('container');
  const previous = params.get('previous') === '1';
  const tailLines = Number(params.get('tail')) || 500;
  const dirParam = params.get('dir');
  const dir = isLogDirection(dirParam) ? dirParam : DEFAULT_LOG_DIRECTION;
  const levelParam = params.get('level');
  const level = isLevelFloor(levelParam) ? levelParam : DEFAULT_LEVEL_FLOOR;
  // Local, not URL: a search is a keystroke-rate value, and writing it to the URL would push one
  // history entry per character. The selection is what a link needs to carry, not the draft query.
  const [search, setSearch] = useState('');
  const [autoMs, setAutoMs] = useState(0);

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  // Fetch all pods cluster-wide so the namespace dropdown always retains the full list of namespaces
  const inventory = useAsync(
    useCallback(() => api.pods(id), [id]),
    60_000,
    id
  );

  const allPods = inventory.data?.data?.items ?? [];
  const namespaces = useMemo(() => [...new Set(allPods.map(p => p.namespace))].sort(), [allPods]);
  const pods = useMemo(
    () => orderPods(!filterNs ? allPods : allPods.filter(p => p.namespace === filterNs), POD_LIST_ORDER),
    [allPods, filterNs]
  );
  const pod = pods.find(p => p.name === podName && (!namespace || p.namespace === namespace)) ?? null;

  // A pod param that no longer resolves (namespace filtered away, pod deleted, dead deep link)
  // must not leave the tab on "no pod selected". Take the top of the list the operator is actually
  // looking at, rather than re-deriving a priority here: the list order already decides what
  // "first" means, and a selection that disagrees with the visible order reads as a bug.
  useEffect(() => {
    if (pod || pods.length === 0) return;
    const next = pods[0];
    if (!next) return;
    set({ ns: next.namespace, pod: next.name, container: null, previous: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pod, pods]);

  // Default the container to the first non-init one; an init container's log is almost
  // never what someone opening a pod wants first.
  const effectiveContainer =
    container ?? pod?.containers.find(c => !c.init)?.name ?? pod?.containers[0]?.name ?? null;
  const containerInfo = pod?.containers.find(c => c.name === effectiveContainer) ?? null;

  const log = usePodLogTail({
    cluster: id,
    namespace: pod?.namespace ?? null,
    pod: pod?.name ?? null,
    container: effectiveContainer,
    tailLines,
    previous,
    autoMs,
    dir,
    search,
    level
  });

  const envelope = inventory.data;

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* -------------------------------------------------- what to read */}
      <aside className="card flex w-[320px] shrink-0 flex-col overflow-hidden">
        <header className="panel-head flex h-[44px] shrink-0 items-center justify-between">
          <h2 className="text-[14px] font-semibold uppercase tracking-[0.06em] text-muted">Pods</h2>
          <div className="flex items-center gap-2">
            {inventory.data?.data && (
              /* The visible count first, the cluster total after it when a filter is narrowing the
                 list. "18 of 214 pods" is the honest header for a filtered list; "214 pods" above
                 eighteen rows is the kind of quiet mismatch this console treats as a defect. */
              <span className="mono text-[12px] text-muted">
                {filterNs && pods.length !== inventory.data.data.summary.pods
                  ? `${pods.length} of ${inventory.data.data.summary.pods}`
                  : String(inventory.data.data.summary.pods)}{' '}
                pods
              </span>
            )}
          </div>
        </header>

        <div className="panel-head flex shrink-0 items-center gap-2 py-2">
          <select
            value={filterNs}
            /* Filtering the list only. It deliberately does not clear `pod`: narrowing to a
               namespace that still contains the selected pod should keep reading it, and when it
               does not, the effect above selects the top of the new list. */
            onChange={e => set({ filterNs: e.target.value })}
            className="mono h-8 min-w-0 flex-1 rounded-[6px] border border-line bg-raised px-2 text-[13px]"
            aria-label="Filter pods by namespace"
          >
            <option value="">all namespaces</option>
            {namespaces.map(ns => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
          <Btn onClick={() => inventory.reload()} disabled={inventory.loading}>
            {inventory.loading ? 'Loading…' : 'Rescan'}
          </Btn>
        </div>

        {inventory.initial && <Skeleton rows={8} />}
        {!inventory.initial && envelope && !envelope.ok && envelope.error && (
          <ErrorState
            cluster={envelope.cluster.id}
            code={envelope.error.code}
            message={envelope.error.message}
            needsReseed={envelope.error.needsReseed}
            command={
              envelope.error.needsReseed
                ? seedCommand(envelope.cluster.namespace, envelope.cluster.serviceAccount)
                : undefined
            }
          />
        )}
        {!inventory.initial && envelope?.ok && pods.length === 0 && (
          <Empty title="No pods" hint="Nothing is running in the selected scope." />
        )}
        {!inventory.initial && envelope?.ok && pods.length > 0 && (
          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {pods.map(p => (
              <PodItem
                key={`${p.namespace}/${p.name}`}
                pod={p}
                selected={pod?.name === p.name && pod?.namespace === p.namespace}
                onSelect={() => set({ ns: p.namespace, pod: p.name, container: null, previous: null })}
              />
            ))}
          </ul>
        )}
      </aside>

      {/* -------------------------------------------------------- the log */}
      <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
        {!pod && (
          <Empty
            title="No pod selected"
            hint="Pick a pod from the list. Pods with a bad phase or a restart are sorted to the top."
          />
        )}

        {pod && (
          <>
            {/* container tabs — the selection stays visible while the log scrolls */}
            <div className="panel-head flex shrink-0 items-center gap-1 overflow-x-auto py-2">
              {pod.containers.map(c => {
                const active = c.name === effectiveContainer;
                return (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => set({ container: c.name, previous: null })}
                    className={`flex h-7 shrink-0 items-center gap-2 rounded-[6px] px-2.5 text-[13px] transition-colors ${
                      active ? 'bg-raised font-medium text-text' : 'text-muted hover:text-text'
                    }`}
                    aria-pressed={active}
                  >
                    <Dot tone={c.ready ? 'ok' : c.reason ? 'bad' : 'warn'} />
                    <span className="mono">{c.name}</span>
                    {c.init && <span className="text-[11px] uppercase text-muted">init</span>}
                    {c.restarts > 0 && <span className="mono text-warn">↻{c.restarts}</span>}
                  </button>
                );
              })}
            </div>

            <PodLogsControls
              tailLines={tailLines}
              onTailLines={n => set({ tail: String(n) })}
              dir={dir}
              onDir={d => set({ dir: d })}
              level={level}
              onLevel={l => set({ level: l === DEFAULT_LEVEL_FLOOR ? null : l })}
              autoMs={autoMs}
              onAutoMs={setAutoMs}
              search={search}
              onSearch={setSearch}
              containerInfo={containerInfo}
              previous={previous}
              onPrevious={p => set({ previous: p ? '1' : null })}
              loading={log.loading}
              onReload={log.reload}
            />

            <PodLogsViewer
              loading={log.initial}
              errorCode={log.errorCode}
              errorMessage={log.errorMessage}
              lines={log.lines}
              stream={log.stream}
              total={log.total}
              truncated={log.truncated}
              bytesTruncated={log.bytesTruncated}
              partialLinesDropped={log.partialLinesDropped}
              fetchedAt={log.fetchedAt}
              filtered={log.filtered}
              unclassified={log.unclassified}
              siblings={pod.containers.filter(c => c.name !== effectiveContainer)}
              dir={dir}
              streamKey={log.streamKey}
              onSwitchContainer={c => set({ container: c, previous: null })}
            />
          </>
        )}
      </section>
    </div>
  );
}

function PodItem({ pod, selected, onSelect }: { pod: LogPod; selected: boolean; onSelect: () => void }) {
  const bad = pod.phase !== 'Running' && pod.phase !== 'Succeeded';
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full border-l-[3px] px-4 py-2.5 text-left transition-colors ${
          selected ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="mono min-w-0 truncate text-[13px]" title={pod.name}>
            {pod.name}
          </span>
          <Pill tone={bad ? 'bad' : pod.restarts > 0 ? 'warn' : 'ok'}>{pod.phase}</Pill>
        </div>
        <div className="mono mt-1 flex items-center gap-2 text-[12px] text-muted">
          <span className="min-w-0 truncate">{pod.namespace}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">{pod.containers.length}c</span>
          {pod.restarts > 0 && <span className="shrink-0 text-warn">↻{pod.restarts}</span>}
          {/* The age, because the list order is otherwise unreadable from the rows — a reader would
              have to trust the sort rather than see it. `—` when the pod has no start time. */}
          <span className="ml-auto shrink-0" title={pod.startedAt ? `started ${pod.startedAt}` : 'not started'}>
            {pod.startedAt ? ago(pod.startedAt) : '—'}
          </span>
        </div>
        {pod.node && (
          <div className="mono truncate text-[12px] text-muted" title={`node ${pod.node}`}>
            {pod.node}
          </div>
        )}
      </button>
    </li>
  );
}
