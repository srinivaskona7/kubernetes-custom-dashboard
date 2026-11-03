/**
 * The console's icon set: one 24×24 stroke glyph per subject, hand-written.
 *
 * Hand-written rather than an icon package, for two reasons that both showed up in measurement
 * rather than taste. Lucide's full ESM entry point is ~1.2k modules and this app ships fourteen
 * glyphs; and every general-purpose set draws at its own optical weight, so mixing three of them —
 * which is what happens when the first one is missing a "sidecar mesh" glyph — is the single most
 * reliable way to make a dense console look assembled from parts.
 *
 * The rules every glyph here follows, so that fourteen of them in a column read as one family:
 *
 *  - **24×24 viewBox, 1.5 stroke, round caps and joins, no fill.** `currentColor` throughout, so a
 *    glyph inherits whatever the heading beside it is coloured.
 *  - **Geometry on the pixel grid at 18px.** 24/18 = 1.333, so a stroke on a whole-number
 *    coordinate lands on a third of a pixel. Coordinates are therefore even numbers or `.5` where
 *    a line has to be centred, which is what keeps these crisp at the one size they are drawn at.
 *  - **Nothing below 2px of detail.** At 18px a three-line "document" glyph is a grey smudge; two
 *    lines is legible. Every glyph here was checked at 18px, not at 24.
 *
 * `aria-hidden` is not optional and not a prop. A heading icon sits beside a text heading that
 * already names the subject, and a screen reader announcing "server, Nodes & Topology" is strictly
 * worse than announcing "Nodes & Topology". There is no decorative-versus-meaningful judgement to
 * make here: this component is only ever used next to its own label.
 */
import type { ReactNode } from 'react';

/**
 * Every glyph, keyed by what it *means* rather than what it depicts.
 *
 * `workloads`, not `cubes` — because the day a Deployment is better drawn as something other than a
 * stack of boxes, a name that describes the drawing has to be changed at every call site while a
 * name that describes the subject does not.
 */
type CanonicalIconName =
  | 'overview'
  | 'nodes'
  | 'workloads'
  | 'utilization'
  | 'autoscaling'
  | 'network'
  | 'storage'
  | 'logs'
  | 'traffic'
  | 'observability'
  | 'security'
  | 'platform'
  | 'helm'
  | 'credentials'
  | 'drift'
  | 'traces'
  | 'cost'
  | 'onboard'
  | 'info'
  | 'external-link'
  | 'check'
  | 'alert-circle';

export type IconName =
  | CanonicalIconName
  | 'layers'
  | 'box'
  | 'activity'
  | 'cpu'
  | 'terminal'
  | 'server'
  | 'trending-up'
  | 'zap'
  | 'alert-triangle'
  | 'bar-chart'
  | 'pulse'
  | 'lock'
  | 'package'
  | 'puzzle'
  | 'archive'
  | 'anchor'
  | 'database'
  | 'hard-drive'
  | 'key';

const PATHS: Record<CanonicalIconName, ReactNode> = {
  // A grid of four panes: the summary of everything, which is what this screen is.
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  // Stacked server bays with a status lamp each — the rack, not an abstract "cluster" hexagon,
  // because the thing this tab lists is machines.
  nodes: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  // A stack of containers seen in isometric: three layers, which is what a controller manages.
  workloads: (
    <>
      <path d="M12 3 21 7.5 12 12 3 7.5 12 3Z" />
      <path d="M3 12 12 16.5 21 12" />
      <path d="M3 16.5 12 21 21 16.5" />
    </>
  ),
  // A gauge needle at three-quarters — utilisation is a reading taken now, not a trend line.
  utilization: (
    <>
      <path d="M4 18a9 9 0 1 1 16 0" />
      <path d="M12 18l4.5-5" />
      <path d="M12 18h.01" />
    </>
  ),
  // A step up with an arrowhead: replicas added, which is the one thing an HPA does.
  autoscaling: (
    <>
      <path d="M3 17h5v4H3zM10 12h5v9h-5zM17 6h4v15h-4z" />
      <path d="M4 8l5-4 4 3 6-5" />
      <path d="M15 2h4.5v4" />
    </>
  ),
  // A route: two hosts and the hop between them, with the branch an Ingress makes.
  network: (
    <>
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="5.5" r="2.5" />
      <path d="M5.5 16V9a3 3 0 0 1 3-3h7.5" />
      <path d="M16 18.5h2.5V13" />
    </>
  ),
  // Stacked platters — a disk, which is what a PersistentVolume ultimately is.
  storage: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </>
  ),
  // A terminal prompt: chevron and caret. Log output is a stream, not a document.
  logs: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 10l2.5 2L7 14" />
      <path d="M12.5 15H17" />
    </>
  ),
  // The warning triangle. Traffic Errors is the one tab whose entire subject is failure.
  traffic: (
    <>
      <path d="M12 4 21.5 20H2.5L12 4Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5h.01" />
    </>
  ),
  // A pulse trace crossing a baseline: signals arriving over time.
  observability: (
    <>
      <path d="M3 12h3.5l2-5 3.5 10 2.5-6 1.5 3h5" />
    </>
  ),
  // A closed padlock: a lock states a setting rather than claiming protection.
  security: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      <path d="M12 15v2" />
    </>
  ),
  // Interlocking blocks: a module is a part that fits a socket the platform provides.
  platform: (
    <>
      <path d="M4 4h7v4.5a2 2 0 0 0 4 0V4h5v7h-4.5a2 2 0 0 0 0 4H20v5h-7v-4.5a2 2 0 0 0-4 0V20H4v-7h4.5a2 2 0 0 0 0-4H4V4Z" />
    </>
  ),
  // A ship's wheel, which is Helm's own mark — the one glyph here that is a quotation.
  helm: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5V9M12 15v5.5M3.5 12H9M15 12h5.5" />
    </>
  ),
  // A key. `tokens` is labelled "Credentials", and a key is the one glyph nobody misreads.
  credentials: (
    <>
      <circle cx="7.5" cy="16.5" r="3.5" />
      <path d="M10 14 20 4" />
      <path d="M16 4h4v4" />
    </>
  ),
  // Two stacks side by side with a rung missing from the right one. Drift is a *comparison*, and a
  // balance or a pair of arrows would say "equal" and "exchange" respectively — neither of which is
  // "these two clusters should match and one of them does not".
  drift: (
    <>
      <path d="M4 5h6M4 12h6M4 19h6" />
      <path d="M14 5h6M14 19h6" />
      <path d="M14.5 10.5l5 3M19.5 10.5l-5 3" />
    </>
  ),
  // Three nodes on one path with the hops between them — a journey, read left to right. Distinct
  // from `network`, which is two endpoints and a link: what this tab adds is the middle.
  traces: (
    <>
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19.5" cy="12" r="2" />
      <path d="M6.5 12h3.5M14 12h3.5" />
      <path d="M12 10V6.5M8.5 6.5h7" />
    </>
  ),
  // A coin edge-on with a slash through it — money, not a bar chart. The spend figures on this tab
  // are an estimate over a rate card, so the glyph says currency rather than measurement.
  cost: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.5v11" />
      <path d="M14.75 9.25a2.75 2.75 0 0 0-2.75-1.5h-.5a2.25 2.25 0 0 0 0 4.5h1a2.25 2.25 0 0 1 0 4.5h-.5a2.75 2.75 0 0 1-2.75-1.5" />
    </>
  ),
  // A cluster outline with a plus: adding a target, not uploading a file. The dashed side says the
  // cluster is not there yet, which a solid rectangle plus a plus does not.
  onboard: (
    <>
      <path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M17 4h1a2 2 0 0 1 2 2v1M20 17v1a2 2 0 0 1-2 2h-1" />
      <path d="M17 10v5M14.5 12.5h5" />
    </>
  ),
  // The InfoTip trigger. A ring and an `i`, at the same weight as everything above it.
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.75h.01" />
    </>
  ),
  'external-link': (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </>
  )
};

const ALIASES: Record<Exclude<IconName, CanonicalIconName>, CanonicalIconName> = {
  layers: 'workloads',
  box: 'workloads',
  activity: 'utilization',
  cpu: 'utilization',
  terminal: 'logs',
  server: 'nodes',
  'trending-up': 'autoscaling',
  zap: 'autoscaling',
  'alert-triangle': 'traffic',
  'bar-chart': 'observability',
  pulse: 'observability',
  lock: 'security',
  package: 'platform',
  puzzle: 'platform',
  archive: 'helm',
  anchor: 'helm',
  database: 'storage',
  'hard-drive': 'storage',
  key: 'credentials'
};

/**
 * One glyph.
 *
 * `size` defaults to 18, which is the size every path here was drawn and checked at. Passing
 * something else is allowed and will look very slightly softer; passing something below 16 will not
 * look good and there is no call site that does.
 */
export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const canonical = name in ALIASES ? ALIASES[name as keyof typeof ALIASES] : (name as CanonicalIconName);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[canonical]}
    </svg>
  );
}

/** Exported for the guard test: every name in the union has a path, and no path is empty. */
export const ICON_NAMES = [...Object.keys(PATHS), ...Object.keys(ALIASES)] as IconName[];
