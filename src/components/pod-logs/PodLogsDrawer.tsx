/**
 * Pod logs in a bottom drawer, over whatever page asked for them.
 *
 * The problem it solves is navigational, not visual. Every "Logs" action in this console used to be
 * a jump to the Live Pod Logs tab, which meant the operator lost the thing they were looking at:
 * the node they had selected, the namespace filter they had set, the row they had scrolled to. For
 * the most common question in an incident — *what is this pod saying?* — the cost of asking was
 * throwing away the context that made the question worth asking.
 *
 * So the drawer is deliberately **not** a page:
 *
 * - It renders where it is mounted (the app shell), as `position: fixed` over the bottom of the
 *   content column. Nothing about the page underneath changes: no route change, no query param
 *   written, no re-render of the table, no scroll position touched.
 * - It is **not modal**. No scrim, no focus trap, `role="complementary"`. The page above it stays
 *   visible and clickable, which is the point — you read a line, glance at the row above, click the
 *   next pod. Trapping focus in a panel while the content beside it is plainly usable is a lie the
 *   screen reader would repeat. (`DetailPanel` makes the same distinction for the same reason.)
 * - It is resizable from its top edge, and the clamp lives in `drawer-size.ts` so a window resize
 *   is subject to the same bounds as a drag.
 *
 * The log itself is not reimplemented here: `usePodLogTail` is the one reader, `PodLogsControls` the
 * one control row, `PodLogsViewer` the one pane. This file is the shell, the pod identity header,
 * and the hand-off to the full Live Pod Logs tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Btn, Dot, Empty, ErrorState, Pill, Skeleton } from '../ui';
import { useAsync } from '../../useAsync';
import { DEFAULT_LOG_DIRECTION, type LogDirection } from '../../pages/cluster-tabs/log-pods';
import { logParams } from '../../pages/cluster-tabs/log-link';
import { DEFAULT_LEVEL_FLOOR, type LevelFloor } from './level';
import { clampDrawerPx, defaultDrawerPx, drawerPxFromPointer, nudgeDrawerPx } from './drawer-size';
import { PodLogsControls } from './PodLogsControls';
import { PodLogsViewer } from './PodLogsViewer';
import { usePodLogTail } from './use-pod-log-tail';

/** Where the drawer should read from. The only thing a caller has to know to open it. */
export interface PodLogTarget {
  cluster: string;
  namespace: string;
  pod: string;
  /** Null lets the drawer pick the first non-init container, which is what a reader wants first. */
  container?: string | null;
  /** Open on the instance before the last restart. Only honoured when one exists. */
  previous?: boolean;
}

/** How tall a keyboard nudge moves the top edge. Roughly two log lines. */
const NUDGE_PX = 40;

export function PodLogsDrawer({ target, onClose }: { target: PodLogTarget; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const { cluster } = target;

  // ------------------------------------------------------------------ size
  const [height, setHeight] = useState(() => defaultDrawerPx(window.innerHeight));
  const dragging = useRef(false);

  // A window resize has to re-clamp the stored height, or a drawer dragged tall on a large window
  // keeps that height when the window shrinks and pushes its own close button off-screen.
  useEffect(() => {
    const onResize = () => setHeight(h => clampDrawerPx(h, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * Publish the drawer's height so the page underneath can scroll past it.
   *
   * Being `position: fixed` over the bottom of the content column is what keeps the page intact — and
   * it is also what hid the bottom of it: the page's scroll container ended where it always did, so
   * with a 498px drawer open the last ~450px of a long table could not be scrolled into view at all.
   * Measured on the Nodes tab: the scroller bottomed out with the final Scheduled-pods rows still
   * behind the drawer. "Does not navigate away" is worth nothing if it silently amputates the page.
   *
   * The height goes on `:root` rather than the shell because the shell's inline style belongs to
   * `App`, and `main > *` picks it up in `theme.css`. The attribute is what scopes the rule, so the
   * padding exists only while the drawer does.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.podLogs = 'open';
    root.style.setProperty('--pod-logs-h', `${height}px`);
    return () => {
      delete root.dataset.podLogs;
      root.style.removeProperty('--pod-logs-h');
    };
  }, [height]);

  // ----------------------------------------------------------------- close
  // Escape only, and only when the drawer has focus somewhere inside it or nothing else claims the
  // key. A global Escape that always closed the drawer would also close it while the operator was
  // dismissing a select's dropdown, which is the browser's Escape, not ours.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // --------------------------------------------------------- pod identity
  // The same collector the Live Pod Logs tab uses, and the same cache entry: `/clusters/:id/pods` is
  // in the prefetch sweep, so on a cluster page it is usually already warm. It is read here rather
  // than passed in because the drawer needs the *container list* and each container's
  // `hasPrevious` — facts a node's pod list and a utilization row do not carry, and which must not
  // be guessed from a pod's name.
  const inventory = useAsync(
    useCallback(() => api.pods(cluster), [cluster]),
    0,
    cluster
  );
  const pod = useMemo(
    () => inventory.data?.data?.items.find(p => p.namespace === target.namespace && p.name === target.pod) ?? null,
    [inventory.data, target.namespace, target.pod]
  );

  // ------------------------------------------------------------ view state
  // Local, not URL. The drawer opens over a page whose URL describes that page — writing `pod=` and
  // `tail=` into it would make the back button undo a log filter instead of the navigation the
  // operator actually performed, and would collide with the Live Pod Logs tab's own params.
  const [container, setContainer] = useState<string | null>(target.container ?? null);
  const [previous, setPrevious] = useState(target.previous ?? false);
  const [tailLines, setTailLines] = useState(500);
  const [dir, setDir] = useState<LogDirection>(DEFAULT_LOG_DIRECTION);
  const [level, setLevel] = useState<LevelFloor>(DEFAULT_LEVEL_FLOOR);
  const [autoMs, setAutoMs] = useState(0);
  const [search, setSearch] = useState('');

  // Default to the first non-init container: an init container's log is almost never what someone
  // opening a pod wants first. Resolved rather than stored, so it follows the inventory landing.
  const effectiveContainer = container ?? pod?.containers.find(c => !c.init)?.name ?? pod?.containers[0]?.name ?? null;
  const containerInfo = pod?.containers.find(c => c.name === effectiveContainer) ?? null;

  const log = usePodLogTail({
    cluster,
    namespace: target.namespace,
    pod: target.pod,
    container: effectiveContainer,
    tailLines,
    previous,
    autoMs,
    dir,
    search,
    level
  });

  // ------------------------------------------------- hand-off to the tab
  // The full tab, pre-selected, on its own route — §"the existing Live Pod Logs page must remain
  // functional" is satisfied by *using* it rather than by copying it. Built from empty params: the
  // page being left may be the Helm release route or the fleet Overview, whose params mean nothing
  // to the Logs tab. `logParams` owns which keys a log selection consists of (including `filterNs`,
  // without which the named pod is filtered out of the list it is selected in).
  const openFullTab = useCallback(() => {
    const p = logParams(new URLSearchParams(), {
      namespace: target.namespace,
      pod: target.pod,
      container: effectiveContainer,
      previous
    });
    onClose();
    navigate(`/clusters/${encodeURIComponent(cluster)}?${p.toString()}`);
  }, [cluster, effectiveContainer, navigate, onClose, previous, target.namespace, target.pod]);

  const badPhase = pod ? pod.phase !== 'Running' && pod.phase !== 'Succeeded' : false;

  return (
    <aside
      role="complementary"
      aria-label={`Logs for pod ${target.pod} in namespace ${target.namespace}`}
      style={{ height }}
      /* Left edge clears the sidebar at `lg`, where the shell becomes a two-column grid and
         `--sidebar-w` is the first track. Below that the shell is a flex row with no fixed rail,
         so the drawer spans the window. */
      className="pod-logs-drawer fixed bottom-0 left-0 right-0 z-40 flex flex-col border-t border-line bg-surface shadow-2xl lg:left-[var(--sidebar-w)]"
    >
      {/* ------------------------------------------------------ resize handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the log drawer"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={e => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          if (!dragging.current) return;
          setHeight(drawerPxFromPointer(e.clientY, window.innerHeight));
        }}
        onPointerUp={e => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onKeyDown={e => {
          // Arrow keys, because a drag handle reachable only by pointer is not reachable.
          if (e.key === 'ArrowUp') setHeight(h => nudgeDrawerPx(h, NUDGE_PX, window.innerHeight));
          else if (e.key === 'ArrowDown') setHeight(h => nudgeDrawerPx(h, -NUDGE_PX, window.innerHeight));
          else return;
          e.preventDefault();
        }}
        className="group flex h-2.5 shrink-0 cursor-row-resize items-center justify-center bg-raised/60 hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true" className="h-[3px] w-10 rounded-full bg-line-strong group-hover:bg-accent" />
      </div>

      {/* --------------------------------------------------------- identity */}
      <header className="panel-head flex h-[44px] shrink-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Logs</span>
          <span className="mono min-w-0 truncate text-[14px] text-text" title={`${target.namespace}/${target.pod}`}>
            {target.pod}
          </span>
          <span className="mono shrink-0 text-[12px] text-muted">{target.namespace}</span>
          {pod && (
            <Pill tone={badPhase ? 'bad' : pod.restarts > 0 ? 'warn' : 'ok'}>
              {pod.phase}
              {pod.restarts > 0 ? ` ↻${pod.restarts}` : ''}
            </Pill>
          )}
          {pod?.node && (
            <span className="mono hidden shrink-0 text-[12px] text-muted md:inline" title={`node ${pod.node}`}>
              on {pod.node}
            </span>
          )}
        </div>
        <Btn onClick={openFullTab}>Open in Live Pod Logs</Btn>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close logs"
          title="Close logs (Esc)"
          className="grid size-7 shrink-0 place-items-center rounded-[6px] border border-line text-muted hover:bg-raised hover:text-text"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      {/* ------------------------------------------------ containers + body */}
      {inventory.initial ? (
        <div className="card-body">
          <Skeleton rows={6} />
        </div>
      ) : !pod ? (
        /* An honest dead end rather than an empty pane. A pod can vanish between the table being
           rendered and the drawer being opened, and "no output" would read as a quiet container. */
        inventory.error ? (
          <ErrorState code={inventory.error.code} message={inventory.error.message} />
        ) : (
          <Empty
            title="Pod not found"
            hint={`${target.namespace}/${target.pod} is not in this cluster's current pod list. It may have been replaced since this view was loaded.`}
          />
        )
      ) : (
        <>
          <div className="panel-head flex shrink-0 items-center gap-1 overflow-x-auto py-1.5">
            {pod.containers.map(c => {
              const active = c.name === effectiveContainer;
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => {
                    setContainer(c.name);
                    setPrevious(false);
                  }}
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
            onTailLines={setTailLines}
            dir={dir}
            onDir={setDir}
            level={level}
            onLevel={setLevel}
            autoMs={autoMs}
            onAutoMs={setAutoMs}
            search={search}
            onSearch={setSearch}
            containerInfo={containerInfo}
            previous={previous}
            onPrevious={setPrevious}
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
            onSwitchContainer={c => {
              setContainer(c);
              setPrevious(false);
            }}
          />
        </>
      )}
    </aside>
  );
}
