/**
 * Traffic Errors — which requests are failing in the mesh, and what they were aimed at.
 *
 * ## What the numbers on this screen are
 *
 * A **window**, never a total. The source is Envoy's own access log, read as a bounded tail from
 * up to ten `istio-proxy` containers, so every count here describes the lines that were read and
 * nothing wider. That is why the screen shows counts and never rates: a tail of N lines has no
 * denominator, and "3% of requests failed" computed from one would be a fabrication. The window
 * is stated in place — proxies read, lines read, the time span they cover — rather than in a
 * tooltip, because an operator who mistakes this for a total draws the wrong conclusion from a
 * screen that looks authoritative.
 *
 * The mesh's real request totals live in `istio_requests_total`, and this console cannot reach
 * them: scraping needs `services/proxy` or `pods/proxy`, and both grants were refused during the
 * RBAC audit because either one is arbitrary HTTP GET against any port of any workload.
 *
 * ## Three things that are not errors, and are not drawn as errors
 *
 *   - **`response_code: 0`** — a connection Envoy never answered. Real, worth seeing, and not an
 *     HTTP failure; it gets its own class and sorts below both error classes. On the cluster this
 *     was built against it was 1330 of 1952 lines, so folding it into 5xx would have buried every
 *     genuine finding under it.
 *   - **An external client IP** — expected on an ingress gateway. Shown as `external`, distinct
 *     from `unresolved`, which means an in-cluster address that matches no Pod, Service, endpoint
 *     or Node and therefore signals a gap in what this reader can see.
 *   - **Access logging being off** — a finding about configuration, not an empty error list. The
 *     banner says so, naming the Telemetry CR that decided it, because "no traffic errors" from a
 *     cluster that writes no request lines is the same false-confidence bug as a `0` from a 403.
 *
 * ## Attribution is evidence, never a name match
 *
 * Every resolved cell carries the field that proves it in its tooltip — `status.podIP`, an
 * EndpointSlice that lists the address, the FQDN Envoy itself emitted in `upstream_cluster`. No
 * edge exists because two names look alike.
 *
 * Read-only throughout: this tab views logs and lists objects, and offers no control that changes
 * anything in the cluster.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { COLUMN_INFO } from '../../components/table/column-info';
import { api, DEFAULT_TRAFFIC_TAIL, type TrafficData, type TrafficEndpoint, type TrafficErrorGroup } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { DetailPanel, Field } from '../../components/layout';
import { DiagnosisBody } from '../../components/DiagnosisDrawer';
import { diagnose } from '../../diagnosis';
import { SubTabs, useSection } from '../../components/SubTabs';
import { TAB_SECTIONS } from './tabs';
import { ResourceLink } from '../../components/ResourceLink';
import { Dot, Empty, ErrorBanner, ErrorState, InfoTip, Pill, Skeleton, type Tone } from '../../components/ui';
import { StatTile, UnavailableNotice, envelopeScope } from '../../components/unavailable';
import { useAsync } from '../../useAsync';
import { StaleReadNotice } from '../../components/StaleReadNotice';
import { ago } from '../../format';
import { accessLogEvidence } from './access-log';
import { selectionBiasLine } from './traffic/sample-basis';
import { IngressOverview } from './ingress/IngressOverview';
import { IngressHosts } from './ingress/IngressHosts';
import { IngressListeners } from './ingress/IngressListeners';
import { IngressFailures } from './ingress/IngressFailures';
import { IngressClients } from './ingress/IngressClients';
import { IngressGateway } from './ingress/IngressGateway';
import { IngressPath } from './ingress/IngressPath';
import { IngressCard } from './ingress/parts';
import { egressHops, ingressHops } from './ingress/path-view';
import { failuresLanding, landingParams, problemsUnreadWhy, trafficProblems } from './ingress/problem-landing';
import { ProblemStrip } from './ProblemStrip';
import { failuresEmptyLine, overviewProblems, problemBadges, type IngressTarget, type Problem } from './problems';
import { ProxiesChip, TrafficProxiesRead, useProxiesPanel } from './traffic/ProxiesRead';
import { endpointName } from './traffic/endpoint-label';
import { exactTimestamp, ingressWasRead } from './ingress/shared';
import {
  BUCKET_COLLAPSED,
  BUCKET_LABEL,
  BUCKET_TONE,
  BUCKET_WHY,
  bucketFailures,
  connectionsByClass,
  EDGE_CLASS_LABEL,
  failuresAreBucketed,
  peerAddress,
  type BucketGroup,
  type TrafficSectionId
} from './ingress/edge-view';

/**
 * The five sub-tabs, in the order `TAB_SECTIONS.traffic` declares them (nine until 2026-09-27;
 * `SECTION_ALIASES` in tabs.ts sends the retired ids to the screens that absorbed them).
 *
 * `ingress` is the default: an operator first sees edge health, then opens Failures for active
 * request evidence before investigating hosts, policies, or gateway configuration.
 */
type TrafficSection = TrafficSectionId;

/**
 * The sub-tabs that describe the **edge** rather than the mesh.
 *
 * They suppress the headline strip above, which counts mesh-wide failures from every proxy that was
 * read. Two five-tile strips stacked — one for the mesh, one for the edge — would put two different
 * denominators next to each other with nothing saying which was which, and the mesh's "Server errors:
 * 0" sitting above the edge's error share is exactly the sort of pair an operator reads as one number.
 */
const EDGE_SECTIONS: ReadonlySet<TrafficSection> = new Set<TrafficSection>(['ingress', 'hosts', 'clients', 'gateway']);

const SECTIONS = TAB_SECTIONS.traffic;

/** How wide a tail to ask for. The server clamps to 1000 whatever arrives. */
const TAIL_CHOICES = [200, 300, 500, 1000];

const CLASS_LABEL: Record<TrafficErrorGroup['class'], string> = {
  server: 'server',
  client: 'client',
  'no-response': 'no response'
};

const CLASS_TONE: Record<TrafficErrorGroup['class'], Tone> = {
  server: 'bad',
  client: 'warn',
  'no-response': 'unknown'
};

function attemptedUrl(g: TrafficErrorGroup): string {
  const path = g.path || '';
  if (!g.authority) return path || '— no Host/SNI or path recorded';
  if (!path) return g.authority;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return path;
  return `https://${g.authority}${path.startsWith('/') ? path : `/${path}`}`;
}

function requestAttemptKind(g: TrafficErrorGroup): string {
  if (g.bucket === 'tls-rejected' || g.responseCodeDetails.some(d => d === 'filter_chain_not_found')) return 'TLS handshake rejected before HTTP';
  if (!g.method && !g.path) return 'TCP connection with no HTTP request line';
  if (g.bucket === 'direct-ip') return 'HTTP request to an unadmitted/direct address';
  if (g.bucket === 'policy-blocked') return 'HTTP request refused by ingress policy';
  if (g.bucket === 'not-routed') return 'HTTP request reached ingress but no route matched';
  return 'HTTP request';
}

function decisionLabel(g: TrafficErrorGroup): string {
  if (g.bucket === 'tls-rejected') return 'Rejected at TLS/filter-chain selection';
  if (g.bucket === 'direct-ip') return 'Rejected because the host/address is not admitted';
  if (g.bucket === 'not-routed') return 'Rejected because no ingress route matched';
  if (g.bucket === 'policy-blocked') return 'Rejected by AuthorizationPolicy';
  if (g.class === 'no-response') return 'No HTTP response recorded';
  return g.class === 'server' ? 'Upstream or application returned a server error' : 'Client-visible HTTP error';
}

const CLASS_WHY: Record<TrafficErrorGroup['class'], string> = {
  server:
    '5xx — the upstream answered with a server error, or Envoy could not reach it. The workload is the place to look.',
  client:
    '4xx — the request was rejected. Often the caller, but a 403 from an AuthorizationPolicy and a 404 from a missing route are cluster configuration.',
  'no-response':
    'Envoy recorded response_code 0: the connection produced no HTTP response at all. A client that hung up, a TLS handshake that failed, or a health probe closing early — not an HTTP error.'
};

/**
 * How an address should read.
 *
 * `unresolved` is drawn as a gap rather than as a fault, because that is what it is: the address
 * was genuinely seen, and what is missing is our ability to name it.
 */
function endpointTone(kind: string): Tone {
  if (kind === 'unresolved') return 'unknown';
  if (kind === 'external') return 'unknown';
  return 'ok';
}

/**
 * One resolved address, with the field that proves it on hover and a Pod link where one exists.
 *
 * `peer` marks the caller side. An external caller is counted, never addressed (D1): the server
 * collapses them into one `External clients` row with `ip: null`, and `peerAddress` refuses an
 * external address even from an older server that still sends one.
 */
function Endpoint({ ep, muted = false, peer = false }: { ep: TrafficEndpoint | null; muted?: boolean; peer?: boolean }) {
  if (!ep) {
    return (
      <span className="text-muted/70" title="Envoy recorded no address for this side of the request.">
        —
      </span>
    );
  }
  const ip = peer ? peerAddress(ep) : ep.ip;
  if (peer && ip === null && ep.kind === 'external') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px]" title="Peers outside the cluster are counted, never listed by address.">
        <Dot tone="unknown" />
        External clients
        {ep.distinct !== undefined && <span className="mono text-[11px] text-muted/70">{ep.distinct} distinct</span>}
      </span>
    );
  }
  const label = ep.kind === 'external' || ep.kind === 'unresolved' ? (ip ?? ep.name) : ep.name;
  const title = `${ip ?? ep.name}${ep.port ? `:${ep.port}` : ''} — ${ep.evidence}`;
  if (ep.kind === 'Pod') {
    return (
      <span title={title} className="inline-flex items-center gap-1.5">
        <Dot tone="ok" />
        <ResourceLink refTo={{ kind: 'Pod', namespace: ep.namespace, name: ep.name }} />
      </span>
    );
  }
  // A cluster object names this external address: lead with the name, keep the address beneath it.
  if (!peer && ep.destination) {
    const n = endpointName(ep);
    return (
      <span title={`${title}\nNamed ${n.provenance}`} className="inline-flex min-w-0 items-center gap-1.5 text-[12px]">
        <Dot tone={endpointTone(ep.kind)} />
        <span className="min-w-0">
          <span className="block truncate">{n.primary}</span>
          {n.secondary && <span className="mono block truncate text-[11px] text-muted">{n.secondary}</span>}
        </span>
      </span>
    );
  }
  return (
    <span
      title={title}
      className={`mono inline-flex items-center gap-1.5 text-[12px] ${muted ? 'text-muted' : ''}`}
    >
      <Dot tone={endpointTone(ep.kind)} />
      <span className="truncate">{label}</span>
      {ep.kind === 'unresolved' && <span className="text-[11px] text-muted/70">unresolved</span>}
    </span>
  );
}

/** The upstream Envoy aimed at: the Service when its FQDN resolves, the raw cluster name if not. */
function Upstream({ group, otelFields = false }: { group: TrafficErrorGroup; otelFields?: boolean }) {
  const u = group.upstream;
  if (!u) {
    /*
      A missing `upstream_cluster` means "Envoy never routed this request" ONLY in the Envoy
      vocabulary, where the field exists and was empty. The OpenTelemetry semantic conventions
      have no equivalent field at all, so under an OTel-labelled provider every single row would
      have claimed the request was rejected before routing — including a 503 from a perfectly
      routed upstream. Absence of a field the format never emits is not evidence about the request.
    */
    return otelFields ? (
      <span
        className="text-muted/70"
        title="This access log uses the OpenTelemetry field names, which carry no upstream_cluster. Whether the request was routed cannot be told from this record."
      >
        not recorded
      </span>
    ) : (
      <span
        className="text-muted/70"
        title="Envoy recorded no upstream cluster for this request — it was rejected before routing, at the listener or by a policy."
      >
        not routed
      </span>
    );
  }
  if (u.service) {
    return (
      <span className="mono truncate text-[12px]" title={`${u.raw} — ${u.service.evidence}`}>
        {u.service.namespace}/{u.service.name}
        {u.port ? <span className="text-muted">:{u.port}</span> : null}
      </span>
    );
  }
  return (
    <span
      className="mono truncate text-[12px] text-muted"
      title={
        u.fqdn
          ? `${u.raw} — no Service in this cluster reports the FQDN ${u.fqdn}. A Service is matched on the full FQDN Envoy emitted, never on a bare name.`
          : `${u.raw} — Envoy's own cluster name, which does not name a Service. BlackHoleCluster means no route matched; PassthroughCluster means the request left the mesh unrouted.`
      }
    >
      {u.fqdn ?? u.raw}
    </span>
  );
}

/**
 * The failing-requests list split by bucket: App failed and Not routed open, the two refusals
 * collapsed and counted. A bucket's header says how many requests it holds, not only how many rows,
 * because one scanner row can stand for hundreds of handshakes.
 */
function FailureBuckets({
  buckets,
  columns,
  selectedKey,
  onSelect
}: {
  buckets: BucketGroup[];
  columns: Column<TrafficErrorGroup>[];
  selectedKey: string | null;
  onSelect: (g: TrafficErrorGroup) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-4">
      {buckets.map(b => {
        const known = b.bucket !== 'unclassified';
        const expanded = open[b.bucket] ?? (known ? !BUCKET_COLLAPSED[b.bucket as keyof typeof BUCKET_COLLAPSED] : true);
        const label = known ? BUCKET_LABEL[b.bucket as keyof typeof BUCKET_LABEL] : 'Not classified';
        const why = known
          ? BUCKET_WHY[b.bucket as keyof typeof BUCKET_WHY]
          : 'The server sent these groups without a bucket — typically sidecar lines the edge classifier does not see. Shown as they are, never guessed into a bucket.';
        const tone: Tone = known ? BUCKET_TONE[b.bucket as keyof typeof BUCKET_TONE] : 'unknown';
        return (
          <div key={b.bucket}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(o => ({ ...o, [b.bucket]: !expanded }))}
              className="flex w-full items-baseline gap-3 border-b border-line py-2 text-left transition-colors hover:bg-line/30"
              title={why}
            >
              <span aria-hidden="true" className="mono w-3 text-[12px] text-muted">
                {expanded ? '−' : '+'}
              </span>
              <Pill tone={tone}>{label}</Pill>
              <span className="mono text-[13px]">
                {b.requests.toLocaleString()} request{b.requests === 1 ? '' : 's'}
              </span>
              <span className="mono text-[12px] text-muted">
                {b.groups.length} distinct
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{why}</span>
            </button>
            {expanded && (
              <DataTable
                columns={columns}
                rows={b.groups}
                rowKey={g => g.key}
                shed="wide"
                selectedKey={selectedKey ?? undefined}
                onSelect={onSelect}
                empty={<Empty title="No failing request in this bucket" />}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function TrafficTab({
  id,
  onViewLogs
}: {
  id: string;
  /** Jump into the Live Pod Logs tab on a proxy, so a group can be read line by line. */
  onViewLogs?: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
}) {
  const [tail, setTail] = useState(DEFAULT_TRAFFIC_TAIL);
  const [search, setSearch] = useState('');
  const [klass, setKlass] = useState<'all' | TrafficErrorGroup['class']>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useSection<TrafficSection>(SECTIONS, SECTIONS[0].id);
  /** Proxies read, a panel beside the body driven by `?proxies=1` (the retired `window` sub-tab). */
  const [proxiesOpen, setProxiesOpen] = useProxiesPanel();
  const [, setParams] = useSearchParams();
  /**
   * Where the last Problems press landed, handed to the screen it names so that screen selects the
   * row. A new object per press, so pressing the same row again lands again; a sub-tab change clears it.
   */
  const [focus, setFocus] = useState<IngressTarget | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the *next* read is a person asking for the current tail.
   *
   * The server keeps its answer for a few seconds so that opening this tab does not cost ten
   * pod-log reads every time — but the Refresh control below promises "read the current tail
   * again", and a control that can be served a cached copy is a control that lies. A ref
   * rather than state on purpose: flipping it must not re-render, and it has to be readable by
   * the fetcher `useAsync` already holds rather than changing that fetcher's identity, which
   * would refetch on its own and defeat the whole thing.
   */
  const wantsLiveTail = useRef(false);

  // A primitive key, not the fetcher: `useAsync` refetches on the key, and passing the closure
  // itself loops. Both the cluster and the tail width belong in it, since either changing means
  // the payload in hand describes a different read.
  const { data, loading, error, reload, stale } = useAsync(
    useCallback(() => {
      const fresh = wantsLiveTail.current;
      wantsLiveTail.current = false;
      return api.clusterTrafficErrors(id, { tailLines: tail }, { fresh });
    }, [id, tail]),
    0,
    `${id}:${tail}`,
    // The cluster is the subject: a wider tail or another option keeps the rows, marked stale,
    // instead of blanking the page for a cold read (async-retain.ts).
    { subject: id }
  );

  /** What the Refresh control calls. Always reads the proxies again. */
  const reloadLive = useCallback(() => {
    wantsLiveTail.current = true;
    reload();
  }, [reload]);

  const payload: TrafficData | undefined = data?.ok ? data.data : undefined;
  const scope = useMemo(() => envelopeScope(id, payload?.summary), [payload?.summary, id]);

  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = payload?.errors ?? [];
    return all.filter(g => {
      if (klass !== 'all' && g.class !== klass) return false;
      if (!needle) return true;
      return [
        String(g.code),
        g.method,
        g.path,
        g.authority,
        g.upstream?.fqdn,
        g.upstream?.service?.name,
        g.destination?.name,
        ...g.responseCodeDetails,
        ...g.responseFlags
      ]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(needle));
    });
  }, [payload?.errors, klass, needle]);

  const selected = useMemo(
    () => payload?.errors.find(g => g.key === selectedKey) ?? null,
    [payload?.errors, selectedKey]
  );
  const bucketed = failuresAreBucketed(payload?.errors ?? []);

  /**
   * The deep links from the edge screens into the mesh-wide failing-requests list.
   *
   * They set the same filters a person would set by hand, so what lands is a state the operator can
   * see and undo — not a hidden pre-filter. Two details matter:
   *
   *   - **`code: 0` filters by class, not by text.** `String(0)` as a search needle matches every path
   *     and every code containing a zero, which on this cluster is most of them. The class filter is
   *     what actually means "no response".
   *   - **The list is mesh-wide.** It includes sidecar traffic, not only the gateway's, so the row
   *     count after the jump can exceed the edge count that was clicked. That is stated on the target
   *     screen's own hint rather than silently narrowed here, because narrowing it to the gateway
   *     would mean two different "Failing requests" tables behaving differently for the same filter.
   */
  const showCode = useCallback(
    (code: number) => {
      if (code === 0) {
        setKlass('no-response');
        setSearch('');
      } else {
        setKlass('all');
        setSearch(String(code));
      }
      setSelectedKey(null);
      setActiveSection('failures');
    },
    [setActiveSection]
  );

  const showFlag = useCallback(
    (flag: string) => {
      setKlass('all');
      setSearch(flag);
      setSelectedKey(null);
      setActiveSection('failures');
    },
    [setActiveSection]
  );

  // TLS & Listeners is the second half of Hosts & TLS since 2026-09-27.
  const showListeners = useCallback(() => setActiveSection('hosts'), [setActiveSection]);
  const showFailingRequests = useCallback(() => {
    setKlass('all');
    setSearch('');
    setSelectedKey(null);
    setActiveSection('failures');
  }, [setActiveSection]);
  /** A person picking a sub-tab, or an Overview tile naming one: any earlier landing is over. */
  const goToSection = useCallback(
    (section: TrafficSection) => {
      setFocus(null);
      setActiveSection(section);
    },
    [setActiveSection]
  );

  /**
   * A Problems press: land on the row it names. Failures is this component's own list, so its
   * filters are set here; every other screen receives `focus` and selects its own row. The URL is
   * one write (`landingParams`), which also closes Proxies read: one panel at a time.
   */
  const openProblem = useCallback(
    (p: Problem<IngressTarget>) => {
      const t = { ...p.target };
      setFocus(t);
      if (t.section === 'failures') {
        const l = failuresLanding(t);
        setKlass(l.klass);
        setSearch(l.search);
        setSelectedKey(l.selectedKey);
      } else {
        setSelectedKey(null);
      }
      setParams(prev => landingParams(prev, t.section), { replace: true });
    },
    [setParams]
  );

  /**
   * Bring the landed row into view once the screen has rendered it: the anchor a target names
   * (a hop card, the EnvoyFilters card), flashed so the eye finds it, or else the row the screen
   * selected, which already carries the selected-row highlight. Polled over a few frames because
   * the screen selects its row in its own effect, one render after the section mounts.
   */
  useEffect(() => {
    if (!focus) return;
    let frame = 0;
    let tries = 0;
    let timer = 0;
    let lit: HTMLElement | null = null;
    const step = () => {
      const el = focus.anchor
        ? document.getElementById(focus.anchor)
        : (bodyRef.current?.querySelector<HTMLElement>('tr[data-selected="true"]') ?? null);
      if (!el) {
        if (++tries < 30) frame = window.requestAnimationFrame(step);
        return;
      }
      // A card lands by its heading: centring one taller than the scroller hid its title above the fold.
      el.scrollIntoView({ block: focus.anchor ? 'start' : 'center', behavior: 'smooth' });
      if (focus.anchor) {
        lit = el;
        el.classList.add('ring-2', 'ring-accent');
        timer = window.setTimeout(() => el.classList.remove('ring-2', 'ring-accent'), 1600);
      }
    };
    frame = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      lit?.classList.remove('ring-2', 'ring-accent');
    };
  }, [focus]);

  /** A failure row opens its panel; Proxies read closes so only one panel shows. */
  const selectFailure = useCallback(
    (g: TrafficErrorGroup) => {
      const open = g.key !== selectedKey;
      setSelectedKey(open ? g.key : null);
      if (open && proxiesOpen) setProxiesOpen(false);
    },
    [selectedKey, proxiesOpen, setProxiesOpen]
  );
  const closeProxies = useCallback(() => {
    if (proxiesOpen) setProxiesOpen(false);
  }, [proxiesOpen, setProxiesOpen]);

  /** Whether an ingress window exists at all. Decides between a count and "unknown" on three tab labels. */
  const edgeRead = ingressWasRead(payload?.ingress);

  if (loading && !data) return <Skeleton rows={6} />;

  if (error && !data) {
    return (
      <div className="flex items-center gap-3 py-4">
        <div className="min-w-0 flex-1">
          <ErrorBanner code={error.code} message={error.message} />
        </div>
        <button
          type="button"
          onClick={reloadLive}
          disabled={loading}
          className="inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-2.5 text-[13px] text-text transition-colors hover:border-line-strong disabled:opacity-60"
          title="Read the current tail again. A log window moves, so a refresh shows a different set of requests. The server caps the tail at 1000 lines per proxy."
        >
          {loading ? 'Reading…' : 'Re-read'}
        </button>
      </div>
    );
  }

  if (data && !data.ok) {
    return (
      <ErrorState
        cluster={id}
        code={data.error?.code ?? 'UNKNOWN'}
        message={data.error?.message ?? 'this cluster did not answer'}
        needsReseed={data.error?.needsReseed}
      />
    );
  }

  const w = payload?.window;
  const s = payload?.summary;
  const log = payload?.accessLog;

  /*
    The three states this page is drawn through — nothing was read, nothing was proved, or a real
    measurement — computed in `access-log.ts` because the Observability tab reads the same payload
    and must reach the same verdict from it. See that module for what each one means and why
    `readable === true` is excluded from `unprovenZero`.
  */
  const { readsSkipped, unprovenZero, noEvidence, otelFields, notRead, windowLine } = accessLogEvidence(log, w);

  /**
   * The selection bias behind every mesh-wide share on this tab.
   *
   * `windowLine` states the size of the read. This states which proxies it was drawn from: when the
   * per-request cap bites, ingress gateways and restart-heavy pods are read first, so a share taken
   * across "the whole mesh" is edge-weighted; when a selected proxy answered 403 or timed out, its
   * traffic is missing and the omission follows permissions, not chance. Never empty for a window
   * that exists — on a complete read it says so in as many words, because silence next to a
   * mesh-wide figure reads as "nothing to declare" and would be indistinguishable from an
   * unexamined one. Empty only when there is no window at all.
   */
  const biasLine = selectionBiasLine(w);

  /** The status for a count derived from the log read: the real scope, unless nothing was proved. */
  const countStatus = (label: string) => (noEvidence ? notRead : scope.of(label));

  /*
    The Problems strip each sub-tab opens with (spec 2026-09-27, "Problem first"). `null` on a
    sub-tab is a source that was not read and renders Unavailable with the read it is missing;
    Overview owns its own strip, so the tab renders one only on the other four.
  */
  const path = payload?.ingress?.path;
  const derived = trafficProblems({
    ingress: payload?.ingress,
    errors: payload?.errors,
    noEvidence,
    edgeRead,
    hops: path ? [...ingressHops(path), ...egressHops(path)] : null
  });
  // Overview also lists the policy-refusal lines Access control does, under the same read gate.
  const problems = { ...derived, ingress: overviewProblems(derived.ingress, edgeRead ? payload?.ingress?.access : null) };
  const unreadWhy = problemsUnreadWhy({ ingress: payload?.ingress, edgeRead, notReadWhy: notRead.why });
  // Keyed by sub-tab so "Show N more" does not carry from one sub-tab's list to another's.
  const strip = <ProblemStrip key={activeSection} problems={problems[activeSection]} unavailableWhy={unreadWhy[activeSection]} onOpen={openProblem} emptyText={activeSection === 'failures' ? failuresEmptyLine(payload?.errors) : undefined} />;
  const hostsFocus = focus?.section === 'hosts' ? focus : null;
  /*
    The two denominators, named before the table rather than left to be discovered.

    A host row's REQUESTS column counts every record Envoy logged for that host — HTTP
    requests and raw TCP connections alike (`aggregateHosts` iterates the whole scoped
    window). The Ingress Overview's "Sampled requests" tile counts HTTP records only. Both
    are correct; under one word they look like the same number failing to add up, so the
    split is one line here and the explanation sits in the tip beside it.

    Not gated on a non-zero connection count: the mixed-denominator column is there in
    every case, so an all-HTTP window needs the line just as much.
  */
  // Where the TCP records went, by the same class split the Overview rows print (`connectionsByClass`).
  const tcpSplit = connectionsByClass(payload?.ingress?.classes)
    ?.map(c => `${c.connections.toLocaleString()} ${EDGE_CLASS_LABEL[c.key]}`)
    .join(', ');
  const hostsNote =
    activeSection === 'hosts' && edgeRead && payload ? (
      <p className="mb-3 flex items-baseline gap-2 text-[13px] text-muted">
        <span className="mono">
          {payload.ingress.summary.records.toLocaleString()} records: {payload.ingress.summary.requests.toLocaleString()} HTTP,{' '}
          {payload.ingress.summary.connections.toLocaleString()} TCP
          {tcpSplit ? ` (${tcpSplit})` : ''}
        </span>
        <InfoTip
          title="What a host row counts"
          text={`A host row counts records: ${payload.ingress.summary.records.toLocaleString()} were read at the edge, of which ${payload.ingress.summary.requests.toLocaleString()} were HTTP requests and ${payload.ingress.summary.connections.toLocaleString()} were TCP connections with no request line. Ingress Overview’s “Sampled requests” tile counts the HTTP requests alone, so it reads lower by exactly those connections. The response-code columns and ERROR SHARE count and divide by the HTTP requests only — a connection carries no status code, so it is in neither.`}
        />
      </p>
    ) : null;

  const columns: Column<TrafficErrorGroup>[] = [
    {
      key: 'code',
      header: 'Code',
      pin: true,
      priority: 1,
      width: '78px',
      render: g => (
        <span title={CLASS_WHY[g.class]}>
          <Pill tone={CLASS_TONE[g.class]}>{g.code === 0 ? 'none' : g.code}</Pill>
        </span>
      )
    },
    {
      key: 'count',
      header: 'Seen',
      pin: true,
      priority: 1,
      width: '70px',
      render: g => (
        <span
          className="mono text-[13px]"
          title={`${g.count} matching request${g.count === 1 ? '' : 's'} in the window that was read — not a rate, and not a total for the cluster.`}
        >
          {g.count.toLocaleString()}
        </span>
      )
    },
    {
      key: 'request',
      header: 'Request / URL',
      priority: 1,
      // `max`, not `width`: `.tbl tbody td` sets `white-space: nowrap` under `table-layout: auto`,
      // so a `th` width is a suggestion the longest path overrides. The ceiling is what holds.
      max: '220px',
      render: g => (
        <span className="mono block max-w-[220px] whitespace-normal break-all text-[12px] leading-4" title={attemptedUrl(g)}>
          {g.method && <span className="block text-muted">{g.method}</span>}
          <span>{attemptedUrl(g)}</span>
        </span>
      )
    },
    {
      key: 'host',
      header: 'Host',
      priority: 2,
      max: '140px',
      render: g => (
        <span
          className="mono block truncate text-[12px] text-muted"
          title={
            g.gateway
              ? `${g.authority ?? 'no authority'} — admitted by Gateway ${g.gateway.namespace}/${g.gateway.name} (${g.gateway.evidence})`
              : g.authority ?? 'No Host header was recorded.'
          }
        >
          {g.authority ?? '—'}
        </span>
      )
    },
    {
      key: 'upstream',
      header: 'Upstream',
      priority: 1,
      max: '180px',
      render: g => <Upstream group={g} otelFields={otelFields} />
    },
    {
      key: 'destination',
      header: 'Destination',
      priority: 2,
      max: '160px',
      render: g => <Endpoint ep={g.destination} />
    },
    {
      key: 'why',
      header: 'Envoy’s reason',
      priority: 2,
      max: '170px',
      render: g => {
        const words = [...g.responseCodeDetails, ...g.transportFailures, ...g.responseFlags];
        if (!words.length) return <span className="text-muted/70">—</span>;
        return (
          <span
            className="mono block truncate text-[12px] text-muted"
            // Envoy's own words, verbatim: `response_code_details`, then the transport failure,
            // then the response flags. Rewriting them would change what the proxy said.
            title={`Envoy reported: ${words.join(', ')}`}
          >
            {words[0]}
          </span>
        );
      }
    },
    {
      key: 'last',
      header: 'Last seen',
      info: COLUMN_INFO.lastSeen,
      ...NUMERIC,
      priority: 3,
      width: '104px',
      render: g => (
        <span className="text-[12px] text-muted" title={g.firstSeen ? `First seen ${exactTimestamp(g.firstSeen)}` : undefined}>
          {g.lastSeen ? ago(g.lastSeen) : '—'}
        </span>
      )
    }
  ];

  return (
    /*
      A workspace tab (IS_WORKSPACE): the page never scrolls. The notices, the headline strip and
      the sub-tabs are one `shrink-0` band; below it each sub-tab owns its scroller — the host and
      failure tables scroll beside a detail panel whose body scrolls on its own, and every other
      sub-tab scrolls its body under the band.
    */
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${stale ? '[&_tbody]:opacity-60' : ''}`} aria-busy={stale && loading ? true : undefined}>
      <div className="shrink-0">
      <UnavailableNotice scope={scope} className="mb-4" />

      {error && (
        <div className="pb-4">
          <ErrorBanner code={error.code} message={error.message} />
        </div>
      )}
      <StaleReadNotice stale={stale} loading={loading} failed={!!error} what="requests and hosts" />

      {/* ------------------------------------------------ the access-log verdict, before any count */}
      {/*
        The banner fires on "this tab cannot see the requests", which is wider than "logging is
        off" in two directions. A mesh pointed at `kyma-logs` is `state: 'on'` and shows nothing
        here (`readsSkipped`); and a provider that resolved to nothing leaves `readable: null`, so
        the read is rightly NOT skipped but the zero it produces is still unproven. The original
        condition (`state !== 'on'`) stayed silent for both.
      */}
      {log && (log.state !== 'on' || noEvidence) && (
        <div className="mx-6 mb-4 rounded-[8px] border border-warn/40 bg-warn/5 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <Dot tone={log.state === 'unknown' ? 'unknown' : 'warn'} />
            <span className="text-[13px] font-semibold text-text">
              {readsSkipped
                ? 'The access log does not reach this tab'
                : unprovenZero
                  ? 'No request line came back, and this tab cannot prove one should have'
                  : log.state === 'off'
                    ? 'Envoy access logging is off'
                    : 'Access logging state is unknown'}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted">{log.why}</p>
          {readsSkipped && (
            <p className="mt-1 text-[13px] text-muted">
              No proxy was read, so every count below is "not read", not zero.{' '}
              {/*
                Only claimed when a provider actually has a destination. A Telemetry CR naming a
                tracing provider under `accessLogging` also lands here, and for that one nothing is
                recorded anywhere — telling the operator their requests are safe and pointing them
                at an em-dash was the worst sentence on the page.
              */}
              {log.recordedElsewhere
                ? 'The requests are being recorded — open the destination below to see them.'
                : 'Nothing is recording these requests, here or anywhere else.'}
            </p>
          )}
          {unprovenZero && (
            <p className="mt-1 text-[13px] text-muted">
              The proxies were tailed and returned no request line at all. That is consistent with a
              quiet cluster and equally consistent with a log this tab cannot see, so the counts below
              read as "not read" rather than zero.
            </p>
          )}
          {log.decidedBy.length > 0 && (
            <p className="mono mt-1 text-[12px] text-muted/80">
              Decided by {log.decidedBy.map(d => `${d.namespace}/${d.name}`).join(', ')}
            </p>
          )}
        </div>
      )}

      {/*
        The sub-tab strip, with Proxies read as a chip at its right end rather than a sub-tab or a
        footer: a footer costs a row of table height on a workspace tab, and table height is what
        this screen is short of.
      */}
      <div className="flex items-start gap-2 pt-4">
        <SubTabs
          className="min-w-0 flex-1"
          sections={SECTIONS}
          active={activeSection}
          onSelect={goToSection}
          /*
            Each badge is the number of rows its sub-tab's Problems strip lists, never a row total:
            a Failures badge of 64 over a strip reading "No app failures" was two answers to one
            question. An empty strip has no badge; an unread one (`null`) has none either, never a 0.
          */
          counts={problemBadges(problems)}
        />
        <ProxiesChip
          w={w}
          collectedAt={payload?.collectedAt}
          open={proxiesOpen}
          onToggle={() => {
            if (!proxiesOpen) setSelectedKey(null);
            setProxiesOpen(!proxiesOpen);
          }}
        />
      </div>

      {/* ------------------------------------------------------------------ headline numbers */}
      {/*
        Mesh-wide, so it is hidden on the edge sub-tabs — see `EDGE_SECTIONS` for why two strips with
        two different denominators is worse than one strip per scope. It sits below the sub-tab bar,
        never above it, so the bar holds the same y on every sub-tab, and it says "Mesh-wide" so its
        counts are not read as the edge's.
      */}
      {/* Problems first on Failures too: the mesh-wide tiles sit under its strip, not over it. */}
      {activeSection === 'failures' && strip}
      {!EDGE_SECTIONS.has(activeSection) && (
      <div className="mb-4 border-b border-line pb-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Mesh-wide, every proxy read</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Server errors"
          status={countStatus('traffic errors')}
          value={<span className="mono">{s?.server ?? 0}</span>}
          caption="5xx in the window read"
          valueClass={(s?.server ?? 0) > 0 ? 'text-bad' : 'text-text'}
        />
        <StatTile
          label="Client errors"
          status={countStatus('traffic errors')}
          value={<span className="mono">{s?.client ?? 0}</span>}
          caption="4xx — includes policy denials"
          valueClass={(s?.client ?? 0) > 0 ? 'text-warn' : 'text-text'}
        />
        <StatTile
          label="No response"
          status={countStatus('traffic errors')}
          value={<span className="mono">{s?.noResponse ?? 0}</span>}
          caption="response_code 0 — not an HTTP error"
        />
        <StatTile
          label="Distinct failures"
          status={countStatus('traffic errors')}
          value={<span className="mono">{s?.groups ?? 0}</span>}
          caption="Same code, host, path and upstream"
        />
        <StatTile
          label="Access logging"
          // Both reads decide this tile: the Telemetry CR says whether logging is on, the mesh
          // ConfigMap says whether it lands where this tab reads. A 403 on either one must show.
          status={scope.of('telemetries', 'istio-mesh-config')}
          value={
            /*
              `on` alone was the wrong pill for a mesh logging to `kyma-logs`: green, accurate,
              and read by an operator as "so the empty table below means no failures". The pill
              now reports what this tab can see, which is the question the rest of the page
              answers — the destination is one row down in Proxies read.
            */
            <Pill
              tone={
                log?.state === 'on' ? (noEvidence ? 'warn' : 'ok') : log?.state === 'off' ? 'warn' : 'unknown'
              }
            >
              {log?.state === 'on' && readsSkipped ? 'elsewhere' : log?.state === 'on' && unprovenZero ? 'unproven' : (log?.state ?? 'unknown')}
            </Pill>
          }
          caption={
            readsSkipped
              ? 'Streamed off the pod, not readable here'
              : log?.providers.length
                ? `via ${log.providers.join(', ')}`
                : 'no provider named'
          }
        />
      </div>
      </div>
      )}
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 gap-4">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">

        {activeSection === 'failures' && (
          <div className="flex min-h-0 flex-1 gap-4">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain pb-4">
              <IngressCard
                title="Failing requests"
                label={String(rows.length)}
                hint={`One row per distinct failure — the same code, host, path and upstream, however many times it hit.${windowLine ? ` ${windowLine}.` : ''}`}
              >
                {/*
                  The filters are a row of their own rather than the card's `action`, because
                  the card lays its header out as one non-wrapping line: with the drawer open the
                  column is ~630px, and the hint was squeezed into a six-line ribbon beside them.
                  A full-width wrapping row reads at every width the drawer produces.
                */}
                <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-surface py-2 text-[12px]">
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="path, host, service, reason…"
                    aria-label="Filter failing requests"
                    className="w-[200px] rounded-[6px] border border-line bg-transparent px-2 py-1 text-[12px] text-text placeholder:text-muted/60 focus:border-accent focus:outline-none"
                  />
                  <select
                    value={klass}
                    onChange={e => setKlass(e.target.value as typeof klass)}
                    aria-label="Filter by failure class"
                    className="rounded-[6px] border border-line bg-transparent px-2 py-1 text-[12px] text-text focus:border-accent focus:outline-none"
                  >
                    <option value="all">all classes</option>
                    <option value="server">server (5xx)</option>
                    <option value="client">client (4xx)</option>
                    <option value="no-response">no response</option>
                  </select>
                  <select
                    value={tail}
                    onChange={e => setTail(Number(e.target.value))}
                    aria-label="Lines to read from each proxy"
                    title="How many log lines to read from each proxy. A wider window costs a larger read from every proxy, and the server caps it at 1000."
                    className="rounded-[6px] border border-line bg-transparent px-2 py-1 text-[12px] text-text focus:border-accent focus:outline-none"
                  >
                    {TAIL_CHOICES.map(n => (
                      <option key={n} value={n}>
                        {n} lines
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={reloadLive}
                    className="rounded-[6px] border border-line px-2 py-1 text-muted transition-colors hover:border-accent hover:text-accent"
                    title="Read the current tail again. A log window moves, so a refresh shows a different set of requests."
                  >
                    Re-read
                  </button>
                </div>
                {/*
                  Measured at 1440: eight declared widths summed to 1302px (78+70+260+190+200+190
                  +210+104) in a 1084px container, and `mid` sheds priority 3 only below 1000px —
                  so it never fired and the table clipped instead. Two fixes, together: the caps
                  came down to 1172px, and `wide` sheds below 1300px, which drops Last seen here.
                  The drawer carries first-and-last-seen in full, and the window line above already
                  states the span, so it is the one column this row can lose. Envoy's reason is
                  priority 2 precisely so it does NOT go with it: it is the difference between
                  "a 403" and "an AuthorizationPolicy denied it".

                  1172 still exceeds 1084, and that is not a contradiction: `max` is a ceiling, not
                  a reservation, so a column only claims it when its longest row needs it. The
                  number to trust is the measurement — 0px overflow at 1084 and again at 634 with
                  the drawer open — not the sum. Re-measure rather than re-adding these up.

                  Re-measured after the tab stopped doubling the page gutter: the container went
                  from 993px to 1041px, which took it *above* `wide`'s 1000px priority-2 threshold,
                  so Host, Destination and Envoy's reason came back and the seven columns overflowed
                  by 48px. Widening a container can therefore break a table — the fix is the caps
                  (Request 240→220, Host 160→140, reason 180→170), not a lower tier, because
                  dropping to a tier that sheds at 1041 would hide Envoy's reason at a normal
                  1280px window.
                */}
                {/*
                  Bucketed when the server classifies (plan 2026-09-26): what failed first, what was
                  refused after and collapsed, so 155 scanner handshakes cannot bury two app 5xx.
                  An older server sends no bucket and gets the one flat table it always had.
                */}
                {bucketed && rows.length > 0 ? (
                  <FailureBuckets
                    buckets={bucketFailures(rows)}
                    columns={columns}
                    selectedKey={selectedKey}
                    onSelect={selectFailure}
                  />
                ) : (
                  <DataTable
                    columns={columns}
                    rows={rows}
                    rowKey={g => g.key}
                    shed="wide"
                    selectedKey={selectedKey ?? undefined}
                    onSelect={selectFailure}
                    empty={
                      /*
                        `readsSkipped` is checked before `state === 'on'`, and the order is the
                        whole point. Access logging is genuinely on in the `kyma-logs` case — it is
                        just on somewhere else — so the `on` branch would otherwise print "No 4xx,
                        5xx or unanswered connection in the window that was read" about a window
                        that was never read. An empty table is allowed to say a cluster is clean
                        only when something actually looked.
                      */
                      <Empty
                        title={
                          payload?.errors.length
                            ? 'No failure matches this filter'
                            : noEvidence
                              ? 'No request log was read'
                              : log?.state === 'on'
                                ? 'No 4xx, 5xx or unanswered connection in the window that was read'
                                : 'Nothing to read'
                        }
                        hint={
                          payload?.errors.length
                            ? undefined
                            : noEvidence || log?.state !== 'on'
                              ? log?.why
                              : `This is a statement about ${w?.linesRead ?? 0} log lines, not about the cluster's whole request history. Widen the window or re-read to look again.`
                        }
                      />
                    }
                  />
                )}
              </IngressCard>
              {/*
                Failure analysis, merged in 2026-09-27: the edge's code and flag breakdown, then the
                mesh-wide code list, stacked under the bucket list rather than beside it because the
                right-hand column belongs to the row's DetailPanel.
              */}
              <div className="mt-5 space-y-5">
                <IngressFailures
                  ingress={payload?.ingress}
                  errors={payload?.errors}
                  onShowCode={showCode}
                  onShowFlag={showFlag}
                  onShowListeners={showListeners}
                  onShowFailures={showFailingRequests}
                  notRead={noEvidence ? notRead : null}
                />
                {/*
                  The mesh-wide code list, below the edge's own and labelled as a different scope.
                  Adjacent on purpose: "is this 403 only at the edge or everywhere?" is the next question
                  after reading the strip above, and answering it by making the operator hold one table in
                  their head while they open another is how a console gets a reputation for being hard.
                */}
                <IngressCard
                  title="Response codes across the whole mesh"
                  hint={`Every code from every proxy that was read — gateway and sidecar alike — so the edge's numbers above can be read against what the rest of the mesh saw. ${windowLine ? `${windowLine}. ` : ''}${biasLine}`}
                >
                  {s && s.byCode.length > 0 ? (
                    <div className="divide-y divide-line">
                      {s.byCode.map(c => {
                        const share = s.requests ? Math.round((c.count / s.requests) * 100) : 0;
                        const tone: Tone =
                          c.class === 'server' ? 'bad' : c.class === 'client' ? 'warn' : c.class === 'no-response' ? 'unknown' : 'ok';
                        return (
                          <div key={c.code} className="flex items-center gap-3 py-2">
                            <span className="w-[64px]">
                              <Pill tone={tone}>{c.code === 0 ? 'none' : c.code}</Pill>
                            </span>
                            <span className="mono w-[64px] text-right text-[13px]">{c.count.toLocaleString()}</span>
                            <span className="mono w-[44px] text-right text-[12px] text-muted">{share}%</span>
                            {/* A share of the lines that were read — labelled as such, because it is not
                                a share of the cluster's traffic and must not be mistaken for one. */}
                            <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-line/60" title={`${share}% of the ${s.requests.toLocaleString()} requests read`}>
                              <span
                                className={`block h-full ${
                                  tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : tone === 'unknown' ? 'bg-muted/60' : 'bg-ok'
                                }`}
                                style={{ width: `${Math.max(share, 1)}%` }}
                              />
                            </span>
                            <span className="w-[110px] text-[12px] text-muted" title={CLASS_WHY[c.class as TrafficErrorGroup['class']] ?? 'A successful response.'}>
                              {c.class === 'ok' ? 'success' : CLASS_LABEL[c.class as TrafficErrorGroup['class']]}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      title={noEvidence ? 'No request log was read' : 'No request lines were read'}
                      hint={noEvidence || log?.state !== 'on' ? log?.why : undefined}
                    />
                  )}
                </IngressCard>
              </div>
            </div>

            {/*
              The request half of the drawer title is optional: Envoy records neither method nor
              path for a connection it rejected before parsing the request line, and joining on an
              unguarded `·` left the drawer titled "400 ·" — a separator pointing at nothing. The
              table already says "no path recorded" for those rows; the title just drops the half.
            */}
            {selected && (
              <DetailPanel
                title={[
                  selected.code === 0 ? 'No response' : String(selected.code),
                  [selected.method, selected.path].filter(Boolean).join(' ')
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClose={() => setSelectedKey(null)}
              >
                <Field label="Class" value={<Pill tone={CLASS_TONE[selected.class]}>{CLASS_LABEL[selected.class]}</Pill>} />
                {selected.bucket && (
                  <Field
                    label="Bucket"
                    value={
                      <span className="inline-flex flex-wrap items-baseline gap-2">
                        <Pill tone={BUCKET_TONE[selected.bucket]}>{BUCKET_LABEL[selected.bucket]}</Pill>
                        <span className="text-[13px] text-muted">{BUCKET_WHY[selected.bucket]}</span>
                      </span>
                    }
                  />
                )}
                <Field
                  label="Seen"
                  value={
                    <span title="Within the window this tab read. Not a rate and not a cluster total.">
                      {selected.count} time{selected.count === 1 ? '' : 's'}
                      {selected.firstSeen && selected.lastSeen ? `, ${ago(selected.firstSeen)} → ${ago(selected.lastSeen)}` : ''}
                    </span>
                  }
                />
                <Field label="What this means" value={<span className="text-[13px] text-muted">{CLASS_WHY[selected.class]}</span>} />
                <div className="rounded-[8px] border border-line bg-surface-muted/30 p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Request attempt</div>
                  <div className="space-y-2 text-[13px]">
                    <div><span className="text-muted">Complete URL </span><span className="mono break-all">{attemptedUrl(selected)}</span></div>
                    <div><span className="text-muted">Request type </span>{requestAttemptKind(selected)}</div>
                    <div><span className="text-muted">Ingress decision </span>{decisionLabel(selected)}</div>
                  </div>
                </div>
                <Field label="Host" value={selected.authority ?? '— none recorded'} mono />
                <Field label="SNI / listener" value={selected.authority ?? '— no SNI or Host recorded'} mono />
                {selected.gateway && (
                  <Field
                    label="Admitted by"
                    value={
                      <span title={selected.gateway.evidence}>
                        Gateway {selected.gateway.namespace}/{selected.gateway.name}
                        {selected.gateway.port ? ` :${selected.gateway.port}` : ''}
                      </span>
                    }
                    mono
                  />
                )}
                <Field label="Upstream" value={<Upstream group={selected} otelFields={otelFields} />} />
                <Field label="Destination" value={<Endpoint ep={selected.destination} />} />
                <Field
                  label="Callers"
                  value={
                    selected.sources.length ? (
                      <div className="space-y-1">
                        {selected.sources.map(src => (
                          <div key={`${src.kind}/${src.namespace ?? '-'}/${src.name}`} className="flex items-baseline gap-2">
                            <Endpoint ep={src} muted peer />
                            {src.count ? <span className="mono text-[11px] text-muted/70">×{src.count}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      '— no client address recorded'
                    )
                  }
                />
                {(selected.responseCodeDetails.length > 0 || selected.transportFailures.length > 0 || selected.responseFlags.length > 0) && (
                  <Field
                    label="Envoy’s reason"
                    value={
                      <div className="mono space-y-0.5 text-[12px]">
                        {selected.responseCodeDetails.map(d => (
                          <div key={d} title="response_code_details — Envoy's own account of why it produced this code.">{d}</div>
                        ))}
                        {selected.transportFailures.map(d => (
                          <div key={d} className="text-bad" title="upstream_transport_failure_reason — the connection to the upstream itself failed. Kyma's stock mesh maps this field to %CONNECTION_TERMINATION_DETAILS% instead, so on that mesh it carries the termination detail and is dropped here rather than shown twice under a heading promising something else. A value reaching this row therefore came from a mesh that maps the field as named.">{d}</div>
                        ))}
                        {selected.responseFlags.length > 0 && (
                          <div className="text-muted" title="response_flags — Envoy's short codes: UF upstream connection failure, UH no healthy upstream, URX retry limit, DC downstream disconnect, DPE codec error, NR no route.">
                            flags {selected.responseFlags.join(' ')}
                          </div>
                        )}
                      </div>
                    }
                  />
                )}
                {selected.p50Ms !== null && (
                  <Field
                    label="Duration"
                    value={`p50 ${selected.p50Ms} ms${selected.maxMs !== null ? `, max ${selected.maxMs} ms` : ''}`}
                    mono
                  />
                )}
                <Field
                  label="Reported by"
                  value={
                    <div className="space-y-1">
                      {selected.proxies.map(p => (
                        <div key={`${p.namespace}/${p.pod}`} className="flex items-baseline gap-2">
                          <ResourceLink refTo={{ kind: 'Pod', namespace: p.namespace, name: p.pod }} />
                          <span className="mono text-[11px] text-muted/70">×{p.count}</span>
                          {onViewLogs && (
                            <button
                              type="button"
                              onClick={() => onViewLogs(p.namespace, p.pod, p.container)}
                              className="text-[12px] underline decoration-dotted decoration-line underline-offset-[3px] text-muted transition-colors hover:text-accent hover:decoration-accent"
                              title={`Open this proxy's ${p.container} log, where these lines came from`}
                            >
                              open log
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  }
                />
                {selected.samples.length > 0 && (
                  <Field
                    label="Request ids"
                    value={
                      <div className="mono space-y-0.5 text-[11px] text-muted">
                        {selected.samples.map(r => (
                          <div key={r}>{r}</div>
                        ))}
                      </div>
                    }
                  />
                )}
                {/*
                  The "what went wrong" explanation for this status code, inline rather than behind a
                  second panel: the drawer is already open on the failing request, and a dialog
                  opened from a dialog is one Escape press away from losing the row the operator
                  clicked. `diagnose()` answers for the code alone and says so when it has no
                  tailored copy — `CLASS_WHY` above still carries the class-level sentence, which is
                  a different claim (what a 4xx is) from this one (what a 403 usually is here).
                */}
                <div className="border-t border-line pt-3">
                  <DiagnosisBody diagnosis={diagnose({ kind: 'http', code: selected.code })} />
                </div>
              </DetailPanel>
            )}
          </div>
        )}

        {activeSection === 'ingress' && (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-4 pt-1">
            <IngressOverview
              ingress={payload?.ingress}
              status={countStatus('traffic errors')}
              windowLine={windowLine}
              problems={problems.ingress}
              onOpenProblem={openProblem}
              onNavigate={goToSection}
            />
          </div>
        )}

        {activeSection === 'hosts' && (
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            <IngressHosts
              ingress={payload?.ingress}
              focus={hostsFocus}
              otherPanelOpen={proxiesOpen}
              onPanelOpen={closeProxies}
              before={
                <>
                  {strip}
                  {hostsNote}
                </>
              }
              after={<IngressListeners ingress={payload?.ingress} focus={hostsFocus} />}
            />
          </div>
        )}

        {activeSection === 'clients' && (
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            <IngressClients
              clusterId={id}
              ingress={payload?.ingress}
              before={strip}
              focus={focus?.section === 'clients' ? focus : null}
              otherPanelOpen={proxiesOpen}
              onPanelOpen={closeProxies}
            />
          </div>
        )}

        {/* Gateway & path: the tier's objects first, then each network hop in and out. */}
        {activeSection === 'gateway' && (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-4 pt-1">
            {strip}
            <IngressGateway ingress={payload?.ingress} />
            <div className="mt-5">
              <IngressPath path={payload?.ingress?.path} />
            </div>
          </div>
        )}
      </div>

      {/* Proxies read (was the `window` sub-tab): what was read, what failed, where the log comes from. */}
      {proxiesOpen && w && (
        <DetailPanel title="Proxies read" onClose={() => setProxiesOpen(false)}>
          <TrafficProxiesRead w={w} log={log} />
        </DetailPanel>
      )}
      </div>
    </div>
  );
}
