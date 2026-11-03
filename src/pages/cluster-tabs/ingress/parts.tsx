/**
 * The cells the five ingress screens share.
 *
 * Small and deliberately dull. They exist because the same three claims are made on every one of
 * these screens and each has one honest form:
 *
 *   - a **count** that may be a floor (the host and client lists are capped server-side);
 *   - a **latency pair**, which must say how many samples it rests on, because `upstream_service_time`
 *     is absent on every rejected connection and a p95 over four samples is not a percentile;
 *   - the **gap**, when no ingress proxy was read at all — which is the one state where every number
 *     below is 0 for a reason that has nothing to do with the cluster being quiet.
 *
 * The verdict logic itself is in `shared.ts`, which has no JSX so it can be tested in vitest's node
 * environment. This file is markup over those answers and holds no rules of its own.
 */
import type { ReactNode } from 'react';
import type { IngressHost, IngressLatency, IngressRouteRef, TrafficIngress } from '../../../api';
import { Dot, InfoTip, Pill, type Tone } from '../../../components/ui';
import { ResourceLink } from '../../../components/ResourceLink';
import { Unavailable, type MetricStatus } from '../../../components/unavailable';
import { splitHint } from '../hint';
import { GROUP_LABEL, GROUP_TONE, GROUP_WHY, byteLine, hostTone, hostWhy, ingressGapWhy, share } from './shared';

/**
 * The warn panel that replaces a screen's contents when no ingress window exists.
 *
 * Same chrome as the access-log banner one level up, on purpose: an operator learns one shape for
 * "this is a statement about the reader, not about the cluster". The sentence comes from
 * `ingressGapWhy`, which distinguishes the three causes that all land here.
 */
export function IngressGap({ ingress, children }: { ingress: TrafficIngress | undefined; children?: ReactNode }) {
  return (
    <div className="rounded-[8px] border border-warn/40 bg-warn/5 px-4 py-3">
      <div className="flex items-baseline gap-2">
        <Dot tone="warn" />
        <span className="text-[13px] font-semibold text-text">No ingress window was read</span>
      </div>
      <p className="mt-1 max-w-[92ch] text-[13px] text-muted">{ingressGapWhy(ingress)}</p>
      {children}
    </div>
  );
}

/** A count. Muted at zero so a busy row's digits carry the eye and an empty one does not. */
export function Num({ value, tone, title }: { value: number; tone?: Tone; title?: string }) {
  const cls = value === 0 ? 'text-muted' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-text';
  return (
    <span className={`mono text-[13px] ${cls}`} title={title}>
      {value.toLocaleString()}
    </span>
  );
}

/** A share, or an em-dash. `share()` decides the wording; this decides the colour. */
export function Share({ value, tone, title }: { value: number | null; tone?: Tone; title?: string }) {
  const text = share(value);
  const cls = text === '—' ? 'text-muted/70' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted';
  return (
    <span className={`mono text-[13px] ${cls}`} title={title}>
      {text}
    </span>
  );
}

/**
 * `p50 / p95`, with the sample count in the tooltip.
 *
 * The sample count is not decoration. `upstream_service_time` is absent on every connection Envoy
 * rejected before routing, so on a listener whose traffic is mostly `filter_chain_not_found` the
 * upstream percentiles rest on a handful of lines — and a p95 over four samples is a number, not a
 * percentile. Nearest-rank throughout: `percentile` never interpolates, so every value printed here
 * is one that was actually measured.
 */
export function Latency({ l, what }: { l: IngressLatency | undefined; what: string }) {
  if (!l || l.samples === 0 || l.p50Ms === null) {
    return (
      <span className="text-muted/70" title={`No ${what} was recorded on any line in this window.`}>
        —
      </span>
    );
  }
  const title =
    `${what}: p50 ${l.p50Ms} ms, p95 ${l.p95Ms ?? '—'} ms, p99 ${l.p99Ms ?? '—'} ms, max ${l.maxMs ?? '—'} ms ` +
    `over ${l.samples} line${l.samples === 1 ? '' : 's'} that carried it. Nearest-rank, never interpolated.` +
    (l.samples < 20 ? ' Fewer than twenty samples — read p95 as an observation, not as a percentile.' : '');
  return (
    <span className="mono text-[13px]" title={title}>
      {l.p50Ms}
      <span className="text-muted"> / </span>
      {l.p95Ms ?? '—'}
      {l.samples < 20 && <span className="text-muted/70"> ·{l.samples}</span>}
    </span>
  );
}

/** Which bucket a host fell into, with the sentence that says how it was decided. */
export function GroupPill({ host }: { host: IngressHost }) {
  const why =
    host.group === 'corporate' && host.matchedSuffix
      ? `${GROUP_WHY.corporate} This host matched ${host.matchedSuffix}.`
      : GROUP_WHY[host.group];
  return (
    <Pill tone={GROUP_TONE[host.group]} title={why}>
      <span className="truncate">{GROUP_LABEL[host.group]}</span>
    </Pill>
  );
}

/**
 * The host itself, with its health as a dot beside it.
 *
 * The dot rather than a column of its own: nine columns already fit this table at 1440 only because
 * every one of them is narrow, and a health verdict is a property of the row's subject rather than a
 * separate fact to scan down. `hostWhy` is the whole sentence, on the cell.
 */
export function HostCell({ host }: { host: IngressHost }) {
  const why = hostWhy(host);
  if (!host.host) {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        title={`${GROUP_WHY.none} ${why}`}
      >
        <Dot tone={hostTone(host)} />
        <span className="text-[12px] italic text-muted">no Host header</span>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={`${host.host} — ${why}`}>
      <Dot tone={hostTone(host)} />
      <span className="mono truncate text-[12px]">{host.host}</span>
    </span>
  );
}

/**
 * The objects that declare a host — a VirtualService, an Ingress or an HTTPRoute.
 *
 * An empty list is a finding and says so: nothing in the cluster publishes this host, so whatever is
 * answering for it is answering through a Gateway with no route behind it.
 *
 * Plain text in a table row, a `ResourceLink` in the drawer. `DataTable` puts no propagation guard on
 * its row click, so a link inside a selectable row fires the link *and* toggles the row — two
 * navigations from one click. The drawer has no row under it, so there the link is free.
 */
export function RouteRefs({ refs, empty, link = false }: { refs: IngressRouteRef[]; empty: string; link?: boolean }) {
  const first = refs[0];
  if (!first) return <span className="text-[12px] text-muted/70">{empty}</span>;
  const evidence = refs.map(r => `${r.kind} ${r.namespace}/${r.name} — ${r.evidence}`).join('\n');
  if (!link) {
    return (
      <span className="inline-flex min-w-0 items-baseline gap-1.5" title={evidence}>
        <span className="mono truncate text-[12px]">
          {first.name}
          <span className="text-muted"> {first.kind === 'VirtualService' ? 'VS' : first.kind}</span>
        </span>
        {refs.length > 1 && <span className="mono text-[11px] text-muted/70">+{refs.length - 1}</span>}
      </span>
    );
  }
  return (
    <div className="space-y-1">
      {refs.map(r => (
        <div key={`${r.kind}/${r.namespace}/${r.name}`} className="flex items-baseline gap-2" title={r.evidence}>
          <ResourceLink refTo={{ kind: r.kind, namespace: r.namespace, name: r.name }} />
          <span className="text-[11px] text-muted/70">{r.kind}</span>
          <span className="mono text-[11px] text-muted/70">{r.matched}</span>
        </div>
      ))}
    </div>
  );
}

/** A byte total, or the honest gap. `byteLine` decides which; see its note on why 0 is not null. */
export function Bytes({ total }: { total: number | null }) {
  const { text, title } = byteLine(total);
  return (
    <span className={`mono text-[13px] ${total === null ? 'text-muted/70' : ''}`} title={title}>
      {text}
    </span>
  );
}

/**
 * A listener port, or the row for lines that carried no local address.
 *
 * `null` is not folded into an em-dash silently — a record with no `downstream_local_address` is a
 * record this reader cannot place on a listener, and saying so is the difference between "not
 * recorded" and "port 0".
 */
export function PortLabel({ port }: { port: number | null }) {
  if (port === null) {
    return (
      <span className="text-[12px] text-muted/70" title="Envoy recorded no downstream local address on these lines, so the listener they arrived on is unknown.">
        not recorded
      </span>
    );
  }
  return <span className="mono text-[13px]">{port}</span>;
}

/** A panel's body when its read failed or the server does not send it: the reason, never a zero. */
export function ReadGap({ status }: { status: MetricStatus }) {
  return (
    <p className="text-[13px]">
      <Unavailable what={status.what} why={status.why} />
    </p>
  );
}

/**
 * The one section card on every ingress screen: a left-aligned title with its count, one line of
 * description, an optional control on the right, and a body.
 *
 * Same props as `Section`, so a screen swaps one for the other without touching its contents. The
 * body is `card-body-flush`, so a table's rules run the card's full width and its first column
 * starts under the title; anything that is not a table takes the same inset. No `overflow-hidden`:
 * it would make the card the scroll container and unstick the sticky toolbars inside it.
 */
export function IngressCard({
  title,
  label,
  hint,
  action,
  className = '',
  children
}: {
  title: string;
  /** A count or short tally beside the title. */
  label?: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { line, tip } = splitHint(hint);
  return (
    <section className={`min-w-0 rounded-[8px] border border-line bg-surface ${className}`}>
      <header className="panel-head flex items-start justify-between gap-4 rounded-t-[8px] bg-raised/20 py-3">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-[14px] font-semibold text-text">
            {title}
            {label && <span className="mono text-[12px] font-normal text-muted">{label}</span>}
            {tip && <InfoTip text={tip} title={title} />}
          </h2>
          {line && <p className="mt-0.5 truncate text-[12px] text-muted">{line}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </header>
      <div className="card-body-flush space-y-3 pt-1.5 pb-3 panel-x-children">{children}</div>
    </section>
  );
}
