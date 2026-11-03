/**
 * Architecture — the release's resources as a graph, drawn only from evidence.
 *
 * ## Every edge names a field
 *
 * There is no edge type meaning "the names look alike". The server draws an edge only from something
 * it read — an `ownerReference`, a label selector that matched, a `scaleTargetRef`, an Ingress
 * backend, a volume mount, a `valueFrom`, a TLS `secretName` — and carries the field along as
 * `evidence`. Clicking an edge shows that field. This matters because a name-similarity graph looks
 * exactly as convincing as a real one and sends an operator to the wrong object.
 *
 * ## Why it is hand-drawn SVG
 *
 * No graph library. The console has three runtime dependencies (react, react-dom, react-router-dom)
 * and adding a fourth for one screen would be the largest thing in the bundle; the layout this graph
 * needs is a deterministic layered one, which is ~40 lines. Deterministic also means an operator
 * screenshotting the graph twice gets the same picture, which a force-directed layout cannot promise.
 *
 * ## Lazily loaded
 *
 * The default export is what `HelmReleasePage` reaches through `React.lazy`, so none of this ships
 * to an operator who never opens the tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HelmGraphEdge, HelmGraphNode, HelmRelatedData } from '../../api';
import { Section } from '../../components/layout';
import { Empty } from '../../components/ui';
import { flowColumns, TIER_LABELS, type FlowRule } from './flow-layout';
import { EDGE, GROUP_ORDER, isSupersededReplicaSet, orderGroups, RELATIONSHIP } from './shared';

const NODE_W = 176;
const NODE_H = 46;
const COL_GAP = 244;
const ROW_GAP = 62;
const PAD = 28;

/** Zoom stops. Below MIN the labels are unreadable; above MAX a node fills the frame. */
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;

type LayoutMode = 'flow' | 'grouped';

interface Placed {
  node: HelmGraphNode;
  x: number;
  y: number;
  column: number;
}

/** The tones a node's status can carry, from the payload's own union. */
type StatusTone = NonNullable<HelmGraphNode['status']>['tone'];

/**
 * Status tone → the fill and stroke a node uses.
 *
 * `var(--graph-*)` rather than literal hex, and applied through `style` rather than as an SVG
 * presentation attribute — a presentation attribute does not resolve `var()`, the CSS property of
 * the same name does. This used to be five hardcoded hex pairs, which made the graph the one
 * surface in the product that could not follow a theme change: on a light background the very
 * dark fills stayed very dark and the nodes read as holes punched in the page.
 *
 * Resolving through CSS also avoids the problem the hardcoding was there to dodge in the first
 * place. The concern was reading the palette at *draw* time, which would have made the colours
 * depend on paint order; a `var()` in a style property is resolved by the cascade, not by this
 * component, so there is no read to order.
 *
 * A tone needs a *pair* because a same-coloured fill and stroke is an invisible border: the fill
 * is a deep tint, the stroke is the saturated line. Keyed on the payload's own tone union, so a
 * new tone is a compile error here rather than a node that silently renders grey.
 */
const TONE_FILL: Record<StatusTone, { fill: string; stroke: string }> = {
  ok: { fill: 'var(--graph-ok-fill)', stroke: 'var(--graph-ok-stroke)' },
  warn: { fill: 'var(--graph-warn-fill)', stroke: 'var(--graph-warn-stroke)' },
  bad: { fill: 'var(--graph-bad-fill)', stroke: 'var(--graph-bad-stroke)' },
  accent: { fill: 'var(--graph-accent-fill)', stroke: 'var(--graph-accent-stroke)' },
  unknown: { fill: 'var(--graph-unknown-fill)', stroke: 'var(--graph-unknown-stroke)' }
};

function toneOf(node: HelmGraphNode): { fill: string; stroke: string } {
  if (node.kind === 'HelmRelease') return TONE_FILL.accent;
  return TONE_FILL[node.status?.tone ?? 'unknown'];
}

/**
 * Columns by distance from the release root along the edges that exist.
 *
 * BFS rather than a hierarchy chosen up front, because the hierarchy is what the graph is supposed
 * to reveal: a PVC reached through a StatefulSet sits one column further right than one the manifest
 * rendered directly, and that is a fact about this release, not a drawing convention. A node no edge
 * reaches lands in the last column — it is related to the release (it is in the payload) without a
 * traversable path, and hiding that would be the graph lying by omission.
 *
 * Moved to `./flow-layout` along with the ingress-aware rule that now supersedes it whenever the
 * release has a readable request path. See that file for why there are two rules.
 */

/**
 * Columns by resource group, in the order the Resources tab uses.
 *
 * The `flow` mode's two rules live in `./flow-layout`, where they can be tested — this project's
 * vitest runs without a DOM, so nothing inside a `.tsx` is reachable from a test.
 */
function groupColumns(nodes: HelmGraphNode[]): Map<string, number> {
  const groups = orderGroups([...new Set(nodes.map(n => n.group))]);
  const rank = new Map(groups.map((g, i) => [g, i]));
  return new Map(nodes.map(n => [n.id, rank.get(n.group) ?? groups.length]));
}

/**
 * The tallest a column may get before it spills sideways.
 *
 * A release's own resources all sit at depth 1, so on a real chart that is 18 nodes in a single
 * vertical line running well past the bottom of the frame while the columns beside it hold three.
 * Spilling a full column into a second lane at the same depth keeps the reading order — depth still
 * increases left to right — and turns a wall into a block. 9 is the tallest column that fits the
 * frame's minimum height (520px) at ROW_GAP without scrolling.
 */
const MAX_ROWS = 9;

/**
 * The part of a name worth putting in a 176px box.
 *
 * Almost every object a chart creates is named after the release, so truncating from the right
 * renders eighteen nodes that all read `applecare-responder-a…` — a graph where nothing is
 * identifiable, which is worse than no labels. Dropping the release-name prefix leaves the part
 * that actually differs (`approuter`, `srv-5cdcdb56d9`), and what was dropped is on screen twice
 * over: in the page title and in the node's own tooltip.
 *
 * A name that does not carry the prefix keeps its tail rather than its head, for the same reason —
 * `pv-shoot--kyma--c-9d0…` identifies nothing, `…-c-9d0a141-abc123` does.
 */
function shortName(name: string, release: string): string {
  if (name !== release && release && name.startsWith(`${release}-`)) {
    const rest = name.slice(release.length + 1);
    return rest.length > 22 ? `…${rest.slice(rest.length - 21)}` : rest;
  }
  return name.length > 22 ? `…${name.slice(name.length - 21)}` : name;
}

function layout(
  nodes: HelmGraphNode[],
  edges: HelmGraphEdge[],
  mode: LayoutMode
): { placed: Placed[]; rule: FlowRule | null } {
  const flow = mode === 'flow' ? flowColumns(nodes, edges) : null;
  const columns = flow ? flow.columns : groupColumns(nodes);
  const buckets = new Map<number, HelmGraphNode[]>();
  for (const n of nodes) {
    const col = columns.get(n.id) ?? 0;
    const list = buckets.get(col);
    if (list) list.push(n);
    else buckets.set(col, [n]);
  }
  const groupRank = new Map((GROUP_ORDER as readonly string[]).map((g, i) => [g, i]));
  const placed: Placed[] = [];
  // Lanes are assigned as we go, so a depth that spilled into three lanes pushes the next depth
  // three lanes right rather than drawing on top of it.
  let lane = 0;
  for (const [col, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort(
      (a, b) =>
        (groupRank.get(a.group) ?? 99) - (groupRank.get(b.group) ?? 99) ||
        a.kind.localeCompare(b.kind) ||
        a.name.localeCompare(b.name)
    );
    // Spread evenly rather than filling the first lane to MAX_ROWS and leaving the last with one:
    // 18 nodes read better as 9 + 9 than as 9 + 9 would differ from 17 as 9 + 8.
    const lanes = Math.max(1, Math.ceil(list.length / MAX_ROWS));
    const perLane = Math.ceil(list.length / lanes);
    list.forEach((node, i) => {
      const laneOffset = Math.floor(i / perLane);
      placed.push({
        node,
        column: col,
        x: PAD + (lane + laneOffset) * COL_GAP,
        y: PAD + (i % perLane) * ROW_GAP
      });
    });
    lane += lanes;
  }
  return { placed, rule: flow?.rule ?? null };
}

export default function HelmArchitecture({
  data,
  selected,
  onSelectResource
}: {
  data: HelmRelatedData;
  selected: string | null;
  onSelectResource: (id: string | null) => void;
}): JSX.Element {
  const [mode, setMode] = useState<LayoutMode>('flow');
  const [needle, setNeedle] = useState('');
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  /**
   * Rollout-history ReplicaSets start hidden. On a release upgraded twenty times they are five in six
   * of every node drawn, and every one of them has an edge to the same Deployment — so the graph they
   * produce is a fan that hides the topology it exists to show. The chip below says how many, and
   * turning them on is one click, because they are real objects and pretending otherwise would be a
   * different kind of lie.
   */
  const [showSuperseded, setShowSuperseded] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  /**
   * The superseded ReplicaSets, by node id, so the graph hides exactly what Resources collapses.
   *
   * Derived from `data.resources` rather than from the node itself: a graph node's `status` carries
   * only `{ text, tone }`, not the `desired`/`ready` counts the predicate needs. Both arrays key on
   * the same `Kind/namespace/name` id, so the two tabs cannot end up hiding different sets — which
   * is the whole point, since a graph drawing 24 workloads beside a table listing 4 is the console
   * contradicting itself.
   */
  const supersededIds = useMemo(
    () => new Set(data.resources.filter(isSupersededReplicaSet).map(r => r.id)),
    [data.resources]
  );

  const visibleNodes = useMemo(
    () =>
      data.graph.nodes.filter(
        n => !hiddenGroups.has(n.group) && (showSuperseded || !supersededIds.has(n.id))
      ),
    [data.graph.nodes, hiddenGroups, showSuperseded, supersededIds]
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map(n => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => data.graph.edges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to)),
    [data.graph.edges, visibleIds]
  );
  const { placed, rule } = useMemo(() => layout(visibleNodes, visibleEdges, mode), [visibleNodes, visibleEdges, mode]);
  const positions = useMemo(() => new Map(placed.map(p => [p.node.id, p])), [placed]);

  const bounds = useMemo(() => {
    if (placed.length === 0) return { w: 400, h: 300 };
    return {
      w: Math.max(...placed.map(p => p.x)) + NODE_W + PAD,
      h: Math.max(...placed.map(p => p.y)) + NODE_H + PAD
    };
  }, [placed]);

  const fit = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const scale = Math.min(box.width / bounds.w, box.height / bounds.h, 1);
    setView({
      x: (box.width - bounds.w * scale) / 2,
      y: (box.height - bounds.h * scale) / 2,
      scale: Math.max(scale, MIN_SCALE)
    });
  }, [bounds]);

  // Fit on mount and whenever the drawn size changes — a layout switch or a collapsed group
  // otherwise leaves the graph half off-screen with no clue that it moved.
  useEffect(() => {
    fit();
  }, [fit]);

  const matches = useCallback(
    (n: HelmGraphNode) => {
      const t = needle.trim().toLowerCase();
      if (!t) return true;
      return n.name.toLowerCase().includes(t) || n.kind.toLowerCase().includes(t) || n.group.toLowerCase().includes(t);
    },
    [needle]
  );
  const matchCount = useMemo(() => (needle.trim() ? visibleNodes.filter(matches).length : null), [needle, visibleNodes, matches]);

  const groups = useMemo(() => orderGroups([...new Set(data.graph.nodes.map(n => n.group))]), [data.graph.nodes]);
  const edgeTypes = useMemo(() => [...new Set(data.graph.edges.map(e => e.type))], [data.graph.edges]);
  const activeEdge = edgeId ? data.graph.edges.find(e => e.id === edgeId) ?? null : null;

  /**
   * Zoom about a fixed point, so whatever is under it stays under it.
   *
   * Scaling `view.scale` alone scales about the SVG origin, which slides the graph out from under the
   * cursor — the reason the −/+ buttons used to feel like they moved the graph rather than magnified
   * it. Anchoring keeps the point still: the graph coordinate under `(cx, cy)` before the change must
   * still map to `(cx, cy)` after it, which fixes the translation exactly.
   *
   * `(cx, cy)` are frame-relative pixels: the pointer for a wheel, the frame's centre for a button.
   */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView(v => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      if (scale === v.scale) return v;
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  /** A button zooms about the middle of what the operator is looking at. */
  const zoom = useCallback(
    (factor: number) => {
      const box = frame.current?.getBoundingClientRect();
      zoomAt(factor, (box?.width ?? 0) / 2, (box?.height ?? 0) / 2);
    },
    [zoomAt]
  );

  /**
   * Trackpad pinch and ctrl/⌘+wheel zoom; a plain wheel is left to scroll the page.
   *
   * Registered by hand rather than with `onWheel` because React attaches wheel listeners passively,
   * and a passive listener cannot `preventDefault()` — without that, a pinch zooms the graph *and*
   * the browser. A browser reports pinch as a wheel event with `ctrlKey` set, which is why the same
   * branch serves both gestures.
   *
   * The deltas are coalesced into one animation frame: a trackpad emits wheel events far faster than
   * React can re-render a few hundred SVG nodes, and re-rendering per event is what makes a graph of
   * this size feel like it is dragging behind the gesture. The coalesced delta is then clamped, so a
   * frame that swallowed a whole flick magnifies by at most ~1.9× rather than crossing the entire
   * zoom range in one step — measured: an unclamped mouse notch took 58% to 185%.
   */
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let pending: { dy: number; cx: number; cy: number } | null = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      const p = pending;
      pending = null;
      if (p) zoomAt(Math.exp(-Math.max(-260, Math.min(260, p.dy)) / 400), p.cx, p.cy);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const cx = e.clientX - box.left;
      const cy = e.clientY - box.top;
      pending = { dy: (pending?.dy ?? 0) + e.deltaY, cx, cy };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [zoomAt]);

  if (data.graph.nodes.length === 0) {
    return (
      <Section title="Architecture">
        <Empty
          title="Nothing to draw"
          hint="This release has no live resources this console could read, so there is no topology to show. Check the notice above the tabs before reading that as an empty release."
        />
      </Section>
    );
  }

  return (
    <Section
      title="Architecture"
      hint="Drawn only from fields the server read. Click an edge to see which one."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={needle}
            onChange={e => setNeedle(e.target.value)}
            placeholder="Highlight by name or kind"
            aria-label="Highlight graph nodes"
            className="h-7 w-[200px] rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text placeholder:text-muted"
          />
          {matchCount !== null && <span className="mono text-[12px] text-muted">{matchCount} match</span>}
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            Layout
            <select
              value={mode}
              onChange={e => setMode(e.target.value as LayoutMode)}
              className="h-7 rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text"
              title={
                rule === 'ingress'
                  ? 'This release has a readable request path, so the columns follow it. Without one they fall back to distance from the release.'
                  : 'Columns are distance from the release along the edges the server read.'
              }
            >
              <option value="flow">{rule === 'ingress' ? 'by request path' : 'by dependency depth'}</option>
              <option value="grouped">by resource group</option>
            </select>
          </label>
          <div className="flex items-center gap-1">
            {(
              [
                ['−', () => zoom(1 / 1.25), 'Zoom out (or ⌘/Ctrl + scroll, or pinch)'],
                ['+', () => zoom(1.25), 'Zoom in (or ⌘/Ctrl + scroll, or pinch)'],
                ['Fit', fit, 'Fit the whole graph in view']
              ] as [string, () => void, string][]
            ).map(([label, fn, title]) => (
              <button
                key={label}
                type="button"
                onClick={fn}
                title={title}
                className="h-7 min-w-[28px] rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text transition-colors hover:border-accent hover:text-accent"
              >
                {label}
              </button>
            ))}
            <span
              className="mono w-[42px] text-right text-[12px] text-muted"
              title="Current zoom. Drag to pan; Fit returns the whole graph to view."
            >
              {Math.round(view.scale * 100)}%
            </span>
          </div>
        </div>
      }
    >
      {/* --------------------------------------------------------------- collapse / expand */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-muted">Groups:</span>
        {groups.map(g => {
          const hidden = hiddenGroups.has(g);
          // Counts what this chip would actually draw, so it cannot read 24 beside four drawn nodes.
          const count = data.graph.nodes.filter(
            n => n.group === g && (showSuperseded || !supersededIds.has(n.id))
          ).length;
          return (
            <button
              key={g}
              type="button"
              aria-pressed={!hidden}
              onClick={() =>
                setHiddenGroups(prev => {
                  const next = new Set(prev);
                  if (next.has(g)) next.delete(g);
                  else next.add(g);
                  return next;
                })
              }
              className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
                hidden
                  ? 'border-line text-muted/60 line-through hover:text-muted'
                  : 'border-accent/50 bg-accent/10 text-text hover:border-accent'
              }`}
              title={hidden ? `Show ${g} again` : `Hide the ${count} ${g} node${count === 1 ? '' : 's'}`}
            >
              {g} <span className="mono text-[11px] text-muted">{count}</span>
            </button>
          );
        })}
        {supersededIds.size > 0 && (
          <button
            type="button"
            aria-pressed={showSuperseded}
            onClick={() => setShowSuperseded(v => !v)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
              showSuperseded
                ? 'border-accent/50 bg-accent/10 text-text hover:border-accent'
                : 'border-line text-muted/60 line-through hover:text-muted'
            }`}
            title={
              showSuperseded
                ? 'Hide the earlier-generation ReplicaSets again'
                : 'Draw the earlier-generation ReplicaSets too — they hold zero Pods and all fan out from the same owner'
            }
          >
            superseded <span className="mono text-[11px] text-muted">{supersededIds.size}</span>
          </button>
        )}
      </div>

      {/* ---------------------------------------------------------------------- the canvas */}
      <div
        ref={frame}
        className="relative overflow-hidden rounded-[8px] border border-line bg-raised"
        style={{ height: 'calc(100vh - 260px)', minHeight: 520, maxHeight: 840 }}
      >
        <svg
          role="img"
          aria-label={`Dependency graph of ${visibleNodes.length} resources and ${visibleEdges.length} relationships for release ${data.release.name}. The Resources tab lists the same objects as a table.`}
          className="h-full w-full cursor-grab active:cursor-grabbing"
          onPointerDown={e => {
            drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={e => {
            const d = drag.current;
            if (!d) return;
            setView(v => ({ ...v, x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerLeave={() => {
            drag.current = null;
          }}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
            {/* Edges first so nodes sit on top of them. */}
            {visibleEdges.map(e => {
              const from = positions.get(e.from);
              const to = positions.get(e.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
              const active = edgeId === e.id;
              const dim = needle.trim() !== '' && !matches(from.node) && !matches(to.node);
              return (
                <g key={e.id} opacity={dim ? 0.15 : 1}>
                  {/* A wide invisible stroke so an edge is clickable without hunting for 1px. */}
                  <path d={d} stroke="transparent" strokeWidth={12} fill="none" style={{ cursor: 'pointer' }} onClick={() => setEdgeId(active ? null : e.id)} />
                  <path
                    d={d}
                    stroke={EDGE[e.type].colour}
                    strokeWidth={active ? 2.5 : 1.25}
                    strokeDasharray={e.type === 'associated-with' ? '4 3' : undefined}
                    fill="none"
                    pointerEvents="none"
                  />
                </g>
              );
            })}

            {placed.map(p => {
              const t = toneOf(p.node);
              const dim = !matches(p.node);
              const isSelected = selected === p.node.id;
              const rel = RELATIONSHIP[p.node.relationship];
              return (
                <g
                  key={p.node.id}
                  transform={`translate(${p.x},${p.y})`}
                  opacity={dim ? 0.2 : 1}
                  tabIndex={0}
                  role="button"
                  aria-label={`${p.node.kind} ${p.node.name}${p.node.status ? `, ${p.node.status.text}` : ''}, ${rel.label}`}
                  style={{ cursor: p.node.id === 'release' ? 'default' : 'pointer' }}
                  onClick={() => p.node.id !== 'release' && onSelectResource(isSelected ? null : p.node.id)}
                  onKeyDown={ev => {
                    if ((ev.key === 'Enter' || ev.key === ' ') && p.node.id !== 'release') {
                      ev.preventDefault();
                      onSelectResource(isSelected ? null : p.node.id);
                    }
                  }}
                >
                  <title>{`${p.node.kind} ${p.node.name}\n${p.node.namespace ?? 'cluster-scoped'}\n${rel.label}: ${rel.why}`}</title>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={7}
                    // `style`, not `fill=`/`stroke=`: these are `var()` references and an SVG
                    // presentation attribute does not resolve custom properties.
                    style={{ fill: t.fill, stroke: isSelected ? 'var(--graph-selected-stroke)' : t.stroke }}
                    strokeWidth={isSelected ? 2 : 1.25}
                  />
                  <text
                    x={10}
                    y={18}
                    fontSize={10}
                    style={{ fill: 'var(--graph-label)' }}
                    fontFamily="ui-monospace, monospace"
                  >
                    {p.node.kind}
                  </text>
                  <text
                    x={10}
                    y={33}
                    fontSize={12}
                    style={{ fill: 'var(--graph-text)' }}
                    fontFamily="ui-monospace, monospace"
                  >
                    {shortName(p.node.name, data.release.name)}
                  </text>
                  {p.node.status && (
                    <circle cx={NODE_W - 11} cy={12} r={3.5} style={{ fill: t.stroke }} />
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* --------------------------------------------------------- the clicked edge's proof */}
        {activeEdge && (
          <div className="absolute bottom-3 left-3 right-3 rounded-[8px] border border-line bg-surface/95 px-4 py-3 backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[13px] font-medium text-text">
                  <span
                    className="inline-block h-[3px] w-6 rounded-full"
                    style={{ background: EDGE[activeEdge.type].colour }}
                  />
                  {EDGE[activeEdge.type].label}
                  <span className="mono text-[12px] text-muted">
                    {activeEdge.from === 'release' ? data.release.name : activeEdge.from} → {activeEdge.to}
                  </span>
                </p>
                <p className="mt-1 max-w-[110ch] text-[13px] text-muted">{activeEdge.explanation}</p>
                <p className="mono mt-1 max-w-[110ch] text-[12px] text-muted/80">evidence: {activeEdge.evidence}</p>
              </div>
              <button
                type="button"
                onClick={() => setEdgeId(null)}
                className="shrink-0 rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {/* -------------------------------------------------------------------------- legend */}
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-muted">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-text">Node border</span>
          {(['ok', 'warn', 'bad', 'unknown'] as const).map(k => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-[3px]"
                style={{ background: TONE_FILL[k].fill, border: `1px solid ${TONE_FILL[k].stroke}` }}
              />
              {k === 'unknown' ? 'no status published' : k}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-text">Edge</span>
          {edgeTypes.map(t => (
            <span key={t} className="inline-flex items-center gap-1.5" title={EDGE[t].why}>
              <span className="inline-block h-[3px] w-5 rounded-full" style={{ background: EDGE[t].colour }} />
              {EDGE[t].label}
            </span>
          ))}
        </div>
      </div>
      {/* What the columns mean, said out loud. A layered picture invites being read as a request
          path whether or not it is one, so the caption names which of the two rules drew it. */}
      {rule === 'ingress' && (
        <p className="mono mt-2 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
          <span className="text-text">Columns:</span>
          {TIER_LABELS.map((label, i) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">▸</span>}
              {label}
            </span>
          ))}
        </p>
      )}
      <p className="mt-1.5 max-w-[110ch] text-[12px] text-muted">
        Drag to pan, use the buttons to zoom.{' '}
        {rule === 'ingress' ? (
          <>
            This release has an ingress with a backend the server could resolve, so the columns follow the request: the
            routing object at the left, then the Service it names and the workload owning the Pods that Service selects,
            then everything else. The tiers come from those fields — a <span className="mono">routes-to</span> backend, a{' '}
            <span className="mono">selector</span> match, an <span className="mono">ownerReference</span> — never from
            one name resembling another.
          </>
        ) : (
          <>
            A node with no incoming edge sits in the last column — it is in this release&apos;s live set without a
            traversable path from the release, which is itself worth seeing.
          </>
        )}{' '}
        The Resources tab lists every node here as a table, for keyboard and screen-reader use.
      </p>
    </Section>
  );
}
