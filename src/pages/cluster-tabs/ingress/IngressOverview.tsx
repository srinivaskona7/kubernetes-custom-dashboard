/**
 * Ingress & Traffic → Ingress Overview.
 *
 * The tab's first screen, in priority order: what needs attention, where the edge traffic went (by
 * class), how the operator's own app traffic is doing, whether the gateway can absorb load, and which
 * app hosts are busiest. It classifies before it counts: on the live edge 238 of 303 requests were
 * the load balancer's health probe, so one error share over every line answered no operator question.
 * Every
 * number here is scoped to the **ingress gateway pods only** — `aggregateIngress` filters the parsed
 * records down to the proxies that are gateways and deliberately does not fall back to the whole mesh,
 * because a sidecar's east-west request under a heading that says ingress is the same class of lie as
 * a 403 drawn as a zero.
 *
 * ## The one rate on this tab, and why it is allowed to exist
 *
 * The rest of this tab shows counts and never rates, for the reason its own header states: a tail of N
 * lines has no denominator. The requests/second tile is the exception, and it is honest because the
 * denominator is measured rather than assumed — each gateway's own oldest and newest `start_time` give
 * that proxy's span, the rate is computed per proxy and summed, and the whole figure is **suppressed**
 * when any contributing proxy spans less than 30 seconds. A 300-line tail from a busy gateway covers
 * two seconds, and "587 requests per second" from that is arithmetic, not a measurement. The reason
 * for a suppression is printed where the number would be; see `rateLine`.
 *
 * ## The capacity summary, as objects rather than as log lines
 *
 * Pods, HPA and PDB come from the API server. An HPA pinned at its ceiling and a PDB with zero allowed
 * disruptions are both invisible in an access log and both explain a change in the numbers. The full
 * tier — LB DNS, DNSEntries, EnvoyFilters — is on the Gateway & path sub-tab.
 */
import type { IngressAppTraffic, TrafficIngress } from '../../../api';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { Btn, Dot, Empty, Pill, type Tone } from '../../../components/ui';
import { StatTile, Unavailable, type MetricStatus } from '../../../components/unavailable';
import { sectionLabel } from '../tabs';
import { ProblemStrip } from '../ProblemStrip';
import type { IngressTarget, Problem } from '../problems';
import { IngressCard, IngressGap, Latency, Num } from './parts';
import { GROUP_LABEL, GROUP_TONE, GROUP_WHY, ingressWasRead, rateLine, share } from './shared';
import {
  EDGE_CLASS_LABEL,
  EDGE_CLASS_TONE,
  EDGE_CLASS_WHY,
  appP95Line,
  classBreakdown,
  classUnits,
  notFromServer,
  routingUnread,
  toneBar,
  type TrafficSectionId
} from './edge-view';

type AppHost = IngressAppTraffic['hosts'][number];

export function IngressOverview({
  ingress,
  status,
  windowLine,
  problems,
  onOpenProblem,
  onNavigate
}: {
  ingress: TrafficIngress | undefined;
  /** The read's own verdict, so an unreadable tile cannot look like a quiet edge. */
  status: MetricStatus;
  /** The sentence stating what window these numbers describe, shared with the rest of the tab. */
  windowLine: string;
  /** The attention rows plus the policy-refusal lines (`overviewProblems`); `null` when srv sent no attention list. */
  problems: Problem<IngressTarget>[] | null;
  /** A Problems press: lands on the row it names. */
  onOpenProblem: (p: Problem<IngressTarget>) => void;
  /** Deep links into the other sub-tabs: tiles and the capacity summary. */
  onNavigate: (section: TrafficSectionId) => void;
}): JSX.Element {
  const read = ingressWasRead(ingress);
  const s = ingress?.summary;
  const app = ingress?.app;
  const classes = classBreakdown(ingress?.classes);
  const rate = rateLine(s?.rate);

  /*
    Two separate verdicts. `status` is about the *read* — did the proxies answer. `read` is about the
    *scope* — did any of the proxies that answered happen to be a gateway. Printing 0 for the second
    would be a statement about the cluster drawn from a statement about this reader's access.
  */
  const tile: MetricStatus = read
    ? status
    : { ...status, state: 'unavailable', what: 'the ingress window', why: 'no ingress gateway proxy was read for this cluster' };
  // An older srv sends no `app` block, and `null` means the Gateways and routes reads both failed:
  // either way the tiles say so rather than printing the whole edge, or nothing, as "app".
  const appTile: MetricStatus = tile.state === 'unavailable' || app ? tile : app === null ? routingUnread('App traffic') : notFromServer('App traffic');
  const p95 = app ? appP95Line(app) : null;

  const hostColumns: Column<AppHost>[] = [
    {
      key: 'host',
      header: 'Host',
      pin: true,
      max: '420px',
      sortValue: h => h.host,
      render: h => (
        <span className="mono block truncate text-[12px]" title={h.host}>
          {h.host}
        </span>
      )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '96px',
      sortValue: h => h.requests,
      render: h => <Num value={h.requests} title="App requests to this host in the window that was read — not a rate, not a cluster total." />
    },
    {
      key: 'errors',
      header: 'Errors',
      ...NUMERIC,
      width: '84px',
      sortValue: h => h.errors,
      // Amber, not red: this is 4xx and 5xx together, and srv sends no per-host 5xx split.
      render: h => <Num value={h.errors} tone="warn" title="4xx and 5xx answered to app requests for this host." />
    }
  ];

  return (
    <div className="space-y-5">
      {!read && <IngressGap ingress={ingress} />}

      {/* ------------------------------------------------------------ 1. problems */}
      {/*
        srv's attention rows, as the Problems strip every sub-tab opens with. Overview lists all of
        them, plus the policy-refusal lines Access control shows (info: the allowlist working); each
        row lands on the row it names on its own sub-tab (TrafficTab's openProblem).
      */}
      <ProblemStrip problems={problems} unavailableWhy={notFromServer('The attention list').why} onOpen={onOpenProblem} />

      {/* ------------------------------------------------------------ 2. where it went */}
      {read && s && (
        <IngressCard
          title="Where the edge traffic went"
          label={ingress?.classes ? `${ingress.classes.total.toLocaleString()} records` : undefined}
          hint="Every edge record in exactly one class, first match wins: rejected at TLS, refused by an AuthorizationPolicy, dialled by IP, the platform probe, platform system hosts, then app traffic. Shares are of the records read, never of the cluster's traffic."
        >
          {ingress?.classes ? (
            <div className="divide-y divide-line">
              {classes.map(c => (
                <div key={c.key} className="flex items-center gap-3 py-2">
                  <span className="w-[200px] shrink-0">
                    <Pill tone={EDGE_CLASS_TONE[c.key]} title={EDGE_CLASS_WHY[c.key]}>
                      {EDGE_CLASS_LABEL[c.key]}
                    </Pill>
                  </span>
                  <span className="mono w-[72px] shrink-0 text-right text-[13px]">{c.records.toLocaleString()}</span>
                  <span className="mono w-[52px] shrink-0 text-right text-[12px] text-muted">{share(c.share)}</span>
                  <span
                    className="h-[6px] flex-1 overflow-hidden rounded-full bg-line/60"
                    title={`${c.records.toLocaleString()} of the ${ingress.classes?.total.toLocaleString()} edge records read — not a share of the cluster's traffic`}
                  >
                    <span className={`block h-full ${toneBar(EDGE_CLASS_TONE[c.key])}`} style={{ width: `${Math.max((c.share ?? 0) * 100, 1)}%` }} />
                  </span>
                  <span className="w-[140px] shrink-0 whitespace-nowrap text-right text-[12px] text-muted">{classUnits(c)}</span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <p className="mb-2 text-[13px]">
                <Unavailable what="Traffic classes" why={notFromServer('Traffic classes').why} />
                <span className="ml-2 text-muted">Host groups from this server instead:</span>
              </p>
              <div className="divide-y divide-line">
                {ingress?.groups.map(g => {
                  const pct = s.records ? g.requests / s.records : null;
                  return (
                    <div key={g.group} className="flex items-center gap-3 py-2">
                      <span className="w-[200px] shrink-0">
                        <Pill tone={GROUP_TONE[g.group]} title={GROUP_WHY[g.group]}>
                          {GROUP_LABEL[g.group]}
                        </Pill>
                      </span>
                      <span className="mono w-[72px] shrink-0 text-right text-[13px]">{g.requests.toLocaleString()}</span>
                      <span className="mono w-[52px] shrink-0 text-right text-[12px] text-muted">{share(pct)}</span>
                      <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-line/60">
                        <span className={`block h-full ${toneBar(GROUP_TONE[g.group])}`} style={{ width: `${Math.max((pct ?? 0) * 100, 1)}%` }} />
                      </span>
                      <span className="w-[120px] shrink-0 text-right text-[12px] text-muted">
                        {g.hosts} host{g.hosts === 1 ? '' : 's'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </IngressCard>
      )}

      {/* ------------------------------------------------------------ 3. app traffic */}
      <IngressCard
        title="App traffic"
        hint={`Only requests routed by an Ingress, an HTTPRoute or an application VirtualService — probes, platform hosts and refused scanners are excluded, so these are your applications' numbers. ${windowLine}.`}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile
            label="App requests"
            status={appTile}
            value={<span className="mono">{(app?.requests ?? 0).toLocaleString()}</span>}
            caption={ingress?.classes ? `of ${ingress.classes.total.toLocaleString()} edge records read` : 'of the edge records read'}
            onClick={() => onNavigate('hosts')}
            actionLabel="show the hosts these requests were aimed at"
          />
          <StatTile
            label="App errors"
            status={appTile}
            value={<span className="mono">{(app?.errors ?? 0).toLocaleString()}</span>}
            caption={app ? `${share(app.requests ? app.errors / app.requests : null)} of app requests, 4xx and 5xx` : '4xx and 5xx'}
            valueClass={(app?.errors ?? 0) > 0 ? 'text-warn' : 'text-text'}
            onClick={() => onNavigate('failures')}
            actionLabel="open the failing requests, bucketed"
          />
          <StatTile
            label="App 5xx"
            status={appTile}
            value={<span className="mono">{(app?.server ?? 0).toLocaleString()}</span>}
            caption="the app or the path to it failed"
            valueClass={(app?.server ?? 0) > 0 ? 'text-bad' : 'text-text'}
            onClick={() => onNavigate('failures')}
            actionLabel="open the failing requests, bucketed"
          />
          <StatTile
            label="App 404"
            status={appTile}
            value={<span className="mono">{(app?.notFound ?? 0).toLocaleString()}</span>}
            caption="host admitted, no route for the path"
            valueClass={(app?.notFound ?? 0) > 0 ? 'text-warn' : 'text-text'}
            onClick={() => onNavigate('failures')}
            actionLabel="break the edge down by response code"
          />
          <StatTile
            label="App p95"
            status={appTile}
            value={<span className={`mono ${app && app.p95Ms === null ? 'text-[15px] text-muted' : ''}`}>{p95?.value ?? '—'}</span>}
            caption={p95?.why ?? 'over app requests only'}
          />
        </div>
      </IngressCard>

      {/* ------------------------------------------------------------ 4. capacity */}
      <IngressCard
        title="Gateway capacity"
        hint="Can the edge absorb load: ready pods, the autoscaler's headroom, the disruption budget, and the measured edge rate. From the API server, not the log."
        action={<Btn onClick={() => onNavigate('gateway')}>{sectionLabel('traffic', 'gateway') ?? 'Gateway tier'}</Btn>}
      >
        {ingress?.tier ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <CapacityCell
              label="Gateway pods"
              tone={podTone(ingress.tier.pods)}
              value={`${ingress.tier.pods.ready} of ${ingress.tier.pods.total} ready`}
              caption={ingress.tier.pods.restarts > 0 ? `${ingress.tier.pods.restarts} restarts` : 'no restarts'}
            />
            <CapacityCell
              label="Autoscaler"
              tone={ingress.tier.hpa ? (ingress.tier.hpa.atCeiling ? 'warn' : 'ok') : 'unknown'}
              value={ingress.tier.hpa ? `${ingress.tier.hpa.current ?? '—'} of ${ingress.tier.hpa.min ?? '—'}–${ingress.tier.hpa.max ?? '—'}` : 'no HPA'}
              caption={
                ingress.tier.hpa?.atCeiling
                  ? 'at its ceiling, cannot scale out'
                  : ingress.tier.hpa
                    ? 'replicas, current of min–max'
                    : 'no HPA targets the gateway'
              }
            />
            <CapacityCell
              label="Disruption budget"
              tone={ingress.tier.pdb ? (ingress.tier.pdb.disruptionsAllowed === 0 ? 'warn' : 'ok') : 'unknown'}
              value={ingress.tier.pdb ? `${ingress.tier.pdb.disruptionsAllowed ?? '—'} allowed` : 'no PDB'}
              caption={
                ingress.tier.pdb
                  ? `${ingress.tier.pdb.currentHealthy ?? '—'} healthy of ${ingress.tier.pdb.expectedPods ?? '—'}`
                  : 'no PDB covers the gateway'
              }
            />
            <CapacityCell
              label="Edge rate"
              tone={rate.value === '—' ? 'unknown' : 'ok'}
              value={rate.value}
              caption={rate.why}
              extra={
                read && s ? (
                  <span className="text-[12px] text-muted">
                    upstream <Latency l={s.upstream} what="upstream_service_time" /> ms, every edge record
                  </span>
                ) : null
              }
            />
          </div>
        ) : (
          <Empty
            title="The ingress tier could not be read"
            hint="The pod, Service, HPA and PDB reads behind this panel did not all answer. The page-level notice above names which one and why."
          />
        )}
      </IngressCard>

      {/* ------------------------------------------------------------ 5. top app hosts */}
      {read && (
        <IngressCard
          title="Top app hosts"
          label={app ? String(app.hosts.length) : undefined}
          hint="App hosts by requests in the window read. A row opens Hosts & TLS, where the host's full chain is."
        >
          {app ? (
            <DataTable
              columns={hostColumns}
              rows={app.hosts}
              rowKey={h => h.host}
              onSelect={() => onNavigate('hosts')}
              empty={<Empty title="No app request in this window" hint="Every edge record read was a probe, platform traffic or refused. Widen the window or re-read." />}
            />
          ) : (
            <p className="text-[13px]">
              <Unavailable what="App hosts" why={(app === null ? routingUnread('App hosts') : notFromServer('App hosts')).why} />
            </p>
          )}
        </IngressCard>
      )}

      {ingress && ingress.ingressProxiesUnread.length > 0 && (
        <IngressCard
          title="Gateway pods this read did not get"
          label={String(ingress.ingressProxiesUnread.length)}
          hint="Named rather than subtracted. A gateway whose log this reader was refused says nothing about whether it is serving traffic, so its records are missing from every number above."
        >
          <div className="divide-y divide-line">
            {ingress.ingressProxiesUnread.map(p => (
              <div key={p} className="flex items-baseline gap-3 py-2">
                <Dot tone="warn" />
                <span className="mono text-[12px]">{p}</span>
                <span className="text-[12px] text-muted">see Proxies read for the reason it gave</span>
              </div>
            ))}
          </div>
        </IngressCard>
      )}
    </div>
  );
}

/** One capacity fact: a label, the value with its tone, and the sentence under it. */
function CapacityCell({ label, tone, value, caption, extra }: { label: string; tone: Tone; value: string; caption: string; extra?: JSX.Element | null }) {
  return (
    <div className="rounded-[8px] border border-line bg-surface px-3 py-2.5">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <Dot tone={tone} />
        <span className="mono text-[16px] font-semibold text-text">{value}</span>
      </div>
      <div className="mt-0.5 text-[12px] leading-tight text-muted">{caption}</div>
      {extra && <div className="mt-1">{extra}</div>}
    </div>
  );
}

/**
 * How the gateway pod count should read. Ready against total, from pod status. Zero pods is
 * `unknown` rather than `bad` — the selector matched nothing, which is a statement about the selector.
 */
export function podTone(pods: { total: number; ready: number }): Tone {
  if (pods.total === 0) return 'unknown';
  if (pods.ready === 0) return 'bad';
  if (pods.ready < pods.total) return 'warn';
  return 'ok';
}
