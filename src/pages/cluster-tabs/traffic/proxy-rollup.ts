/**
 * The pure half of the **Response codes** and **Proxies observed** sub-tabs.
 *
 * Named for its largest piece. Everything here is a claim about what the access-log read *did and did
 * not see*, and every one of those claims is a place this page could fabricate a number, so they are
 * functions with tests rather than expressions inside JSX. `app/fleet-ui` runs vitest with
 * `environment: 'node'`, so the rule gets proved here and the `.tsx` files hold only markup.
 *
 * ## The one thing to understand before reading further
 *
 * `TrafficData.errors` holds **failures only**. Everything a per-proxy row can say is therefore a
 * statement about failures, and the one number an operator most wants — how many requests each proxy
 * saw — is not on the wire at any granularity below the whole mesh (`summary.requests`). There is no
 * per-proxy endpoint and `window.linesRead` is a single total. So this module deliberately offers no
 * way to produce a per-proxy request count: the only way to render that column is to divide or
 * estimate, and a plausible fabricated number is the worst thing this console can put on a screen.
 *
 * ## The three proxy states, named for what they are
 *
 * The spec asked for "37 reporting / 4 silent". The backend cannot say *silent*. `window` reports
 * `proxyCandidates` (Running pods with an `istio-proxy` container), `proxiesRead`, `proxiesSkipped`
 * and `proxiesFailed[]` — and a skipped proxy was never asked, which is a budget decision by the
 * collector (`selectProxies` caps the sweep at `maxPods`), not an observation about the proxy. Calling
 * it "silent" would attribute the reader's own limit to the thing being read.
 *
 *   read        the collector tailed it and got lines           `proxiesRead`
 *   not read    the collector never asked — over the cap        `proxiesSkipped`, count only, no names
 *   failed      the collector asked and the read errored        `proxiesFailed[]`, named with a reason
 *
 * "Not read" has no names on the wire, which is why it can only ever be a count beside the table and
 * never a row in it.
 */
import type { TrafficData, TrafficErrorGroup, TrafficWindow } from '../../../api';
import type { Tone } from '../../../components/ui';
import { share } from '../ingress/shared';

/**
 * Which of the three states a *row* can be in.
 *
 * Only two, and that is the point: a not-read proxy cannot be a row because nothing on the wire names
 * it. See the module comment.
 */
export type ProxyState = 'read' | 'failed';

/** One proxy, rolled up across every failure group that named it. */
export interface ProxyRow {
  /** `namespace/pod`. The identity, because a pod name alone repeats across namespaces. */
  key: string;
  pod: string;
  namespace: string;
  /** Container names observed on this pod's entries. Always `istio-proxy` in practice. */
  containers: string[];
  /**
   * Failures this proxy logged in the window, summed across groups.
   *
   * `null` when the read failed — **not** `0`. A refused log says nothing about whether that proxy is
   * failing requests, and this console's contract is that a failed read is never a zero.
   */
  errors: number | null;
  /** How many distinct failure groups named this proxy. A proxy in one group twice counts once. */
  groups: number;
  /**
   * The newest `lastSeen` among the groups this proxy contributed to.
   *
   * An **upper bound**, not this proxy's own last line: a group's timestamp spans every proxy that
   * contributed to it, and the per-proxy entry carries only a count. The cell says so on hover.
   */
  lastSeen: string | null;
  state: ProxyState;
  /** Failed reads only — the collector's own reason and detail, verbatim. */
  reason: string | null;
  detail: string | null;
}

/** Internal shape: the group keys are needed while building and are not part of the row. */
interface Building extends ProxyRow {
  seen: Set<string>;
}

/**
 * Every proxy that logged a failure, plus every proxy whose read failed.
 *
 * Two sources, deliberately merged into one table so the STATUS column carries real variance: a table
 * whose status reads `Read` on every row is a column an operator learns to skip.
 *
 * A proxy that was read and logged **no** failure has no row at all, because `groups` is the failure
 * list and nothing else names it. That is why the count of rows is smaller than `proxiesRead` and why
 * the component prints both.
 */
export function rollUpProxies(
  groups: readonly TrafficErrorGroup[],
  w: TrafficWindow | undefined
): ProxyRow[] {
  const rows = new Map<string, Building>();

  for (const g of groups) {
    for (const p of g.proxies) {
      const key = `${p.namespace}/${p.pod}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          pod: p.pod,
          namespace: p.namespace,
          containers: [],
          errors: 0,
          groups: 0,
          lastSeen: null,
          state: 'read',
          reason: null,
          detail: null,
          seen: new Set<string>()
        };
        rows.set(key, row);
      }
      // Summed across every entry, including two entries for the same pod under different container
      // names: both are lines that pod logged.
      row.errors = (row.errors ?? 0) + p.count;
      // The group count is per *group*, so a pod listed twice inside one group counts once — which is
      // the difference between "named in 3 failure shapes" and "named 4 times".
      if (!row.seen.has(g.key)) {
        row.seen.add(g.key);
        row.groups += 1;
      }
      if (p.container && !row.containers.includes(p.container)) row.containers.push(p.container);
      row.lastSeen = newer(row.lastSeen, g.lastSeen);
    }
  }

  /*
    The failed reads, merged in after. A pod cannot normally be in both — a failed read returns no
    lines, so it contributes no group — but the merge is written so that if it ever is, the failure
    wins the STATUS and whatever it did contribute is kept as a number. Overwriting a real count with
    `null` would hide lines this reader actually has.
  */
  for (const f of w?.proxiesFailed ?? []) {
    const key = `${f.namespace}/${f.pod}`;
    const existing = rows.get(key);
    if (existing) {
      existing.state = 'failed';
      existing.reason = f.reason;
      existing.detail = f.detail;
      continue;
    }
    rows.set(key, {
      key,
      pod: f.pod,
      namespace: f.namespace,
      containers: [],
      errors: null,
      groups: 0,
      lastSeen: null,
      state: 'failed',
      reason: f.reason,
      detail: f.detail,
      seen: new Set<string>()
    });
  }

  return [...rows.values()]
    .map(({ seen: _seen, ...row }) => row)
    /*
      Failed reads first, then busiest. A failed read is the row that changes how every other number
      on the page should be read, and burying it under ten proxies that answered is how a gap in the
      data stops being visible. `errors: null` sorts with its own group rather than as a zero.
    */
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'failed' ? -1 : 1;
      return (b.errors ?? 0) - (a.errors ?? 0) || a.key.localeCompare(b.key);
    });
}

/** The later of two ISO timestamps, ignoring anything unparseable rather than letting `NaN` win. */
function newer(a: string | null, b: string | null): string | null {
  if (!b) return a;
  if (!a) return b;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(y)) return a;
  if (Number.isNaN(x)) return b;
  return y > x ? b : a;
}

/** What the window says was looked at — every field the backend's own number, none derived. */
export interface ReadCoverage {
  /** Running pods with an `istio-proxy` container. The denominator for "observed". */
  observed: number;
  read: number;
  /** Never asked, because the sweep is capped. Counted, never named — the wire carries no names. */
  notRead: number;
  failed: number;
  /** Proxies whose log had older lines beyond the tail. A *different* gap from `notRead`. */
  truncated: number;
  tailLines: number;
  linesRead: number;
  linesUnparsed: number;
  requestsParsed: number;
  /** No read was issued at all: the access log goes somewhere this tab cannot follow. */
  skippedReads: boolean;
  /**
   * Whether `read + failed + notRead` equals `observed`.
   *
   * It does on the live wire (10 + 0 + 31 = 41), and each of the four is read from the payload rather
   * than derived from the other three — so if the collector's accounting ever changes, the component
   * can decline to print a breakdown that does not add up instead of quietly absorbing the difference
   * into whichever number it happened to compute.
   */
  accountedFor: boolean;
}

export function readCoverage(w: TrafficWindow | undefined): ReadCoverage | null {
  if (!w) return null;
  const failed = w.proxiesFailed.length;
  return {
    observed: w.proxyCandidates,
    read: w.proxiesRead,
    notRead: w.proxiesSkipped,
    failed,
    truncated: w.truncatedProxies,
    tailLines: w.tailLines,
    linesRead: w.linesRead,
    linesUnparsed: w.linesUnparsed,
    requestsParsed: w.requestsParsed,
    skippedReads: w.readsSkipped,
    accountedFor: w.proxiesRead + failed + w.proxiesSkipped === w.proxyCandidates
  };
}

/** The partial-visibility banner's copy, or `null` when there is nothing honest to warn about. */
export interface VisibilityNotice {
  title: string;
  /** The claim itself: how many of how many, and what that means for the numbers on the page. */
  message: string;
  /**
   * The truncation fact, kept as its own sentence.
   *
   * A proxy that was read but whose log had older lines beyond the tail is a *different* gap from a
   * proxy that was never read, and folding the two into one number would produce a figure that
   * describes neither. `null` when no proxy was truncated.
   */
  truncatedNote: string | null;
}

/**
 * Whether this page is seeing all of the mesh, and what to say when it is not.
 *
 * `null` in exactly three cases, and each is a case where a warning would be *false* rather than
 * merely unhelpful:
 *
 *  - no window at all — nothing has been established, so there is nothing to claim;
 *  - no proxy observed — there is no mesh here to be partially visible;
 *  - every observed proxy read with no failure — full coverage.
 *
 * Everything else fires. A warning that never fires is as bad as one that always does, and 10 of 41 is
 * genuinely partial visibility.
 */
export function visibilityNotice(w: TrafficWindow | undefined): VisibilityNotice | null {
  const c = readCoverage(w);
  if (!c || c.observed === 0) return null;

  const truncatedNote =
    c.truncated > 0
      ? `Separately, ${c.truncated} ${c.truncated === 1 ? 'proxy had' : 'proxies had'} older lines beyond the ${c.tailLines}-line tail, so this window starts later than ${c.truncated === 1 ? 'its' : 'their'} log does. That is a different gap from a proxy that was not read, and the two are not added together.`
      : null;

  /*
    `readsSkipped` is not a partial read, it is no read — every count on the page then describes
    nothing that was looked at. Calling that "partial" would understate it by the whole window, so it
    gets its own title and its own sentence. The wording follows the Window sub-tab's, which was
    written against a mesh pointed at `kyma-logs`.
  */
  if (c.skippedReads) {
    return {
      title: 'No traffic visibility',
      message: `No proxy was read: the mesh sends its access log somewhere this tab cannot follow, so none of the ${c.observed} observed proxies was tailed. The counts on this page describe nothing that was looked at — they are not evidence that nothing failed.`,
      truncatedNote
    };
  }

  if (c.read === c.observed && c.failed === 0) return null;

  // "read", never "reporting". A proxy that was never asked has not declined to report.
  const parts = [
    `Traffic Errors is currently receiving logs from ${c.read} of ${c.observed} observed proxies. Results may not represent all mesh traffic.`
  ];
  if (c.notRead > 0) {
    parts.push(
      `${c.notRead} ${c.notRead === 1 ? 'proxy was' : 'proxies were'} not read at all — the sweep is capped per request, and ingress gateways and restart-heavy pods are read first. Not read is not the same as quiet.`
    );
  }
  if (c.failed > 0) {
    parts.push(
      `${c.failed} log ${c.failed === 1 ? 'read failed' : 'reads failed'}; the ${c.failed === 1 ? 'proxy is' : 'proxies are'} named on the Proxies observed sub-tab with the reason given. A refused log says nothing about whether that proxy is failing requests.`
    );
  }
  return { title: 'Partial traffic visibility', message: parts.join(' '), truncatedNote };
}

/* ------------------------------------------------------------------- the response-code table */

/** One row of the Response codes table: the class's own name, its colour, and why it says that. */
export interface CodeCategory {
  label: string;
  tone: Tone;
  why: string;
}

/**
 * What a response class is called, **keyed on the class the backend assigned** and never on the number.
 *
 * `classOf` in `srv/fleet/collectors/traffic.js` is the authority: `0` is `no-response`, `>= 500` is
 * `server`, `>= 400` is `client`, everything else is `ok`. Re-deriving a category from the code here
 * would give this table its own second opinion, and the two would disagree the first time either side
 * changed.
 *
 * `ok` is the trap. The mesh classifier folds **3xx in with 2xx**, so a 302 arrives here as `ok` — and
 * the live window has one. Labelling `ok` as "2xx Success" would therefore print a lie on that row.
 * `redirect` is listed because the *ingress* classifier (`httpFamily`) does separate 3xx and the same
 * class strings reach the UI from there; on a mesh-wide `byCode` it never appears.
 */
const CATEGORIES: Record<string, CodeCategory> = {
  client: {
    label: '4xx Client',
    tone: 'warn',
    why: 'A 4xx. The request reached a proxy and was turned away — by an authorisation policy, by a missing route, or because the request itself was malformed. Not a cluster fault on its own.'
  },
  server: {
    label: '5xx Server',
    tone: 'bad',
    why: 'A 5xx. Either the upstream answered with one, or Envoy produced one because it had nothing healthy to ask. The response flags on the failing request are what tell the two apart.'
  },
  'no-response': {
    label: 'No response',
    tone: 'unknown',
    why: 'Envoy wrote response_code 0: the connection closed before any HTTP response. Not a 5xx — often a TLS handshake that matched no listener, or a plain TCP connection that carried no request line.'
  },
  ok: {
    label: 'Answered',
    tone: 'ok',
    why: 'A 2xx or a 3xx. The mesh-wide classifier answers "was this a failure" and folds redirects in with successes, so this row is not necessarily a 2xx — the code beside it is what says which.'
  },
  redirect: {
    label: '3xx Redirect',
    tone: 'accent',
    why: 'A 3xx. Reported as its own class only by the ingress-scoped reader; a mesh-wide count folds redirects into the answered class.'
  }
};

/**
 * The category for a class string, never blank.
 *
 * An unrecognised class prints verbatim and is toned `unknown`, because a class this build has no name
 * for is a gap in the console rather than a finding about the cluster — and an empty CATEGORY cell
 * reads as a rendering bug.
 */
export function categoryOf(cls: string): CodeCategory {
  return (
    CATEGORIES[cls] ?? {
      label: cls || 'unclassified',
      tone: 'unknown',
      why: `The collector reported the class “${cls}” and this console has no name for it. That is a gap in this build, not a new failure mode.`
    }
  );
}

/** Whether a class has failing requests behind it in `data.errors`. See {@link CODE_LINK_WHY}. */
export function isFailingClass(cls: string): boolean {
  return cls === 'client' || cls === 'server' || cls === 'no-response';
}

/**
 * The denominator for the share column: every record `byCode` counted.
 *
 * Summed from the column itself rather than taken from `summary.requests`, so the percentages always
 * total 100% of the rows on screen. The two are equal on the live wire (2,974); summing keeps the
 * table internally consistent if they ever stop being.
 */
export function recordsIn(byCode: TrafficData['summary']['byCode'] | undefined): number {
  return (byCode ?? []).reduce((n, c) => n + c.count, 0);
}

/**
 * One code's share of the records read, as a percentage string.
 *
 * The denominator is stated in the column header, because "89.6%" means something completely
 * different over the 2,974 records read than over the 2,313 that failed, and a percent whose
 * denominator is a guess is worse than no percent.
 *
 * `share()` from the ingress screens does the formatting — imported rather than re-written because the
 * `—` for "no measurement" against `0%` for "a measured zero" is console-wide vocabulary, and a
 * formatter copied into a second file is a rule that drifts in one of them. A zero denominator is `—`:
 * nothing was read, so there is no share, and `NaN%` must never reach a cell.
 *
 * The one thing added on top is the floor. `share()` keeps one decimal below 1%, which is right for a
 * host's error share and not enough here: 1 record of 2,974 is 0.03% and prints as `0.0%`, which reads
 * as a rendering fault sitting next to a count of 1. Below a tenth of a percent this says `<0.1%` —
 * small, and unmistakably not zero.
 */
export function shareOfRecords(count: number, total: number): string {
  if (total <= 0) return share(null);
  const ratio = count / total;
  if (ratio > 0 && ratio * 100 < 0.1) return '<0.1%';
  return share(ratio);
}
