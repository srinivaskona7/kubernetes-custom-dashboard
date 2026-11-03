/**
 * The Proxies read panel, shared by Traffic and Traces (spec 2026-09-27, "Proxies read becomes a
 * chip on both tabs").
 *
 * Both tabs read a bounded tail from a bounded number of proxies, and that bound used to sit in a
 * sub-tab (Traffic's `window`) or a footer (Traces). Neither earned the space: a person needs the
 * one-line answer — how many of how many were read, and whether any failed — and the detail only
 * when that line looks wrong. So the line is a chip at the end of the sub-tab strip, and the detail
 * opens beside the body in a DetailPanel, driven by `?proxies=1` so it survives a reload.
 *
 * The two windows differ: Traces also carries `proxies[]`, the per-proxy lines behind each journey
 * hop, so it gets its own small body. The chip reads only the four fields both windows share.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AccessLogVerdict, TracesData, TrafficWindow } from '../../../api';
import { Field } from '../../../components/layout';
import { Dot, Pill } from '../../../components/ui';
import { ago } from '../../../format';
import { AccessLogProviders } from '../AccessLogProviders';
import { IngressCard } from '../ingress/parts';
import { updatedAgo } from './updated-ago';

/** The four fields the chip reads. Both `TrafficWindow` and the Traces window carry them. */
export type ProxiesChipWindow = {
  proxiesRead: number;
  proxyCandidates: number;
  readsSkipped?: boolean;
  proxiesFailed: unknown[];
};

/**
 * The chip's words. A skipped read says so rather than "0 of 41", which reads as "41 quiet
 * proxies"; a failed read is named and warns, because a refused log is not zero errors.
 */
export function proxiesChipText(w: ProxiesChipWindow | undefined): { text: string; tone: 'muted' | 'warn' } {
  if (!w) return { text: 'Proxies read', tone: 'muted' };
  if (w.readsSkipped) return { text: 'No proxy read', tone: 'warn' };
  const base = `${w.proxiesRead} of ${w.proxyCandidates} proxies read`;
  const failed = w.proxiesFailed.length;
  return failed > 0 ? { text: `${base} · ${failed} failed`, tone: 'warn' } : { text: base, tone: 'muted' };
}

/** `?proxies=1` opens the panel; closing deletes the param. `replace`, as for a section change. */
export function useProxiesPanel(): [boolean, (open: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const open = params.get('proxies') === '1';
  const setOpen = useCallback(
    (next: boolean) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          if (next) p.set('proxies', '1');
          else p.delete('proxies');
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  return [open, setOpen];
}

/**
 * `collectedAt` is the body's oldest log read. Both routes may serve an answer up to 10 minutes
 * old while they refresh it, so the chip says how old: "updated 3 min ago", muted even when the
 * count warns. It sits on a second line: on one line it widened the chip enough to wrap the
 * sub-tabs beside it at 1100px. A 30s tick keeps the minutes moving on a page left open.
 */
export function ProxiesChip({
  w,
  open,
  onToggle,
  collectedAt
}: {
  w: ProxiesChipWindow | undefined;
  open: boolean;
  onToggle: () => void;
  collectedAt?: string;
}) {
  const { text, tone } = proxiesChipText(w);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!collectedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [collectedAt]);
  const age = w ? updatedAgo(collectedAt, now) : undefined;
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={onToggle}
      className={`inline-flex h-8 shrink-0 flex-col items-start justify-center rounded-[6px] border border-line px-2.5 text-[12px] leading-[14px] ${tone === 'warn' ? 'text-warn' : 'text-muted'} ${open ? 'bg-raised' : ''}`}
    >
      {text}
      {age && <span className="text-[11px] leading-[13px] text-muted">{age}</span>}
    </button>
  );
}

/** The window fields the Traffic body reads. The Traces window carries every one of them too. */
export type ProxiesReadWindow = Pick<
  TrafficWindow,
  | 'proxiesRead'
  | 'proxyCandidates'
  | 'proxiesSkipped'
  | 'proxiesFailed'
  | 'tailLines'
  | 'truncatedProxies'
  | 'linesRead'
  | 'requestsParsed'
  | 'linesUnparsed'
  | 'oldest'
  | 'newest'
  | 'readsSkipped'
>;

/** Traffic's former `window` sub-tab, verbatim: what was read, what failed, where the log comes from. */
export function TrafficProxiesRead({ w, log }: { w: ProxiesReadWindow; log: AccessLogVerdict | undefined }) {
  return (
    <div className="space-y-5">
      <IngressCard
        title="What was read"
        hint="This tab reads a bounded tail from a bounded number of proxies. Both bounds are enforced server-side, and both are reported here, because a window mistaken for a total is the one way this screen can mislead."
      >
        {/*
          Under `readsSkipped` every one of these six fields describes a read that was never
          issued, so five of them said something false. `Lines per proxy: 300` is the bound
          that would have applied; `Window: no timestamped lines` asserts lines were read and
          found undated; and worst, `Proxies not read: 2 over the per-request cap` named a
          cause that did not apply and implied the other ten WERE read. This is the sub-tab an
          operator opens to check whether the zeros above are trustworthy — it has to answer
          "nothing was looked at", not "nothing was missed".
        */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 lg:grid-cols-3">
          <Field
            label="Proxies read"
            value={
              w.readsSkipped
                ? `none of ${w.proxyCandidates} — the read was skipped, not empty`
                : `${w.proxiesRead} of ${w.proxyCandidates} with an istio-proxy container`
            }
          />
          <Field
            label="Lines per proxy"
            value={
              w.readsSkipped
                ? `— no proxy was tailed (the bound would have been ${w.tailLines})`
                : `${w.tailLines}${w.truncatedProxies ? ` — ${w.truncatedProxies} proxies had older lines beyond it` : ''}`
            }
          />
          <Field
            label="Request lines parsed"
            value={w.readsSkipped ? '— nothing was read' : `${w.requestsParsed.toLocaleString()} of ${w.linesRead.toLocaleString()} read`}
          />
          <Field
            label="Lines not request records"
            value={
              w.readsSkipped ? (
                '— nothing was read'
              ) : (
                <span title="Envoy writes its own startup and config chatter to the same stream. A large number here can also mean the access log is not in JSON format, in which case this tab refuses to guess at its fields rather than mis-attribute them.">
                  {w.linesUnparsed.toLocaleString()}
                </span>
              )
            }
          />
          <Field
            label="Window"
            value={
              w.readsSkipped
                ? '— no window; nothing was tailed'
                : w.oldest && w.newest
                  ? `${ago(w.oldest)} → ${ago(w.newest)}`
                  : 'no timestamped lines'
            }
          />
          <Field
            label="Proxies not read"
            value={
              w.readsSkipped
                ? `all ${w.proxyCandidates} — the access log does not reach pod stdout`
                : w.proxiesSkipped
                  ? `${w.proxiesSkipped} over the per-request cap — ingress gateways and restart-heavy pods are read first`
                  : 'none'
            }
          />
        </div>
      </IngressCard>

      {w.proxiesFailed.length > 0 && (
        <IngressCard
          title="Proxies that could not be read"
          label={String(w.proxiesFailed.length)}
          hint="Named rather than counted as zero errors. A log this reader was refused says nothing about whether that proxy is failing requests."
        >
          <div className="divide-y divide-line">
            {w.proxiesFailed.map(p => (
              <div key={`${p.namespace}/${p.pod}`} className="flex items-baseline gap-3 py-2">
                <Dot tone="warn" />
                <span className="mono text-[12px]">
                  {p.namespace}/{p.pod}
                </span>
                <Pill tone="unknown">{p.reason}</Pill>
                {p.detail && <span className="truncate text-[12px] text-muted">{p.detail}</span>}
              </div>
            ))}
          </div>
        </IngressCard>
      )}

      <IngressCard
        title="Where the access log comes from"
        hint="Envoy writes a request line only when a Telemetry CR turns access logging on. This is that decision, read from the cluster."
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 lg:grid-cols-3">
          <Field
            label="State"
            value={
              <Pill tone={log?.state === 'on' ? 'ok' : log?.state === 'off' ? 'warn' : 'unknown'}>
                {log?.state ?? 'unknown'}
              </Pill>
            }
          />
          <Field label="Providers" value={log?.providers.length ? log.providers.join(', ') : 'none named'} mono />
          <Field label="Coverage" value={log?.scope === 'mesh' ? 'mesh-wide' : log?.scope === 'partial' ? 'some workloads only' : 'unknown'} />
          <Field
            label="Visible to this tab"
            value={
              <span
                title={
                  log?.readable === true
                    ? 'At least one named provider writes to pod stdout, which is the stream this tab tails.'
                    : log?.readable === false
                      ? 'Every named provider streams the log off the pod. This tab tails pod stdout and cannot follow it, so it read nothing.'
                      : 'A named provider could not be resolved, or its implementation is one this console does not recognise. Unknown is not the same as no.'
                }
              >
                <Pill tone={log?.readable === true ? 'ok' : log?.readable === false ? 'bad' : 'unknown'}>
                  {log?.readable === true ? 'yes' : log?.readable === false ? 'no' : 'unknown'}
                </Pill>
              </span>
            }
          />
        </div>
        <p className="mt-2 text-[13px] text-muted">{log?.why}</p>

        {/*
          The providers, resolved name-by-name against `istio-system/istio`’s `mesh` key, and
          the CRs that chose them. Shared with the Observability tab, which reads the same
          payload and needs the same answer — see `AccessLogProviders`.
        */}
        {log && <AccessLogProviders log={log} />}
      </IngressCard>
    </div>
  );
}

/** Traces' former "Proxies read" footer: the per-proxy lines behind every journey hop. */
export function TracesProxiesRead({
  w
}: {
  w: Pick<TracesData['window'], 'proxies' | 'proxiesRead' | 'proxyCandidates' | 'proxiesSkipped' | 'truncatedProxies' | 'proxiesFailed'>;
}) {
  // The footer's own "Proxies read" heading is gone: the DetailPanel's title says it.
  return (
    <div className="space-y-1">
      <p className="text-[13px] text-muted">
        {w.proxiesRead} of {w.proxyCandidates} proxies carrying an <span className="mono">istio-proxy</span>{' '}
        container were tailed
        {w.proxiesSkipped > 0 && ` — ${w.proxiesSkipped} were not read, and contribute no hop to any journey above`}
        {w.truncatedProxies > 0 && `; ${w.truncatedProxies} returned a shorter window than asked for`}.
      </p>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {w.proxies.map(p => (
          <span
            key={`${p.namespace}/${p.pod}`}
            className="mono rounded-[4px] border border-line px-1.5 py-0.5 text-[11px] text-muted"
            title={`${p.namespace}/${p.pod} — ${p.role}, ${p.lines} lines read, ${p.parsed} parsed as requests${p.truncated ? ', tail truncated' : ''}`}
          >
            {p.role === 'ingress' ? '↧ ' : ''}
            {p.pod}
            <span className="text-muted/60"> {p.parsed}</span>
          </span>
        ))}
      </div>
      {w.proxiesFailed.length > 0 && (
        <p className="text-[13px] text-warn">
          {w.proxiesFailed.length} proxy log read failed:{' '}
          {w.proxiesFailed.map(f => `${f.namespace}/${f.pod} (${f.reason ?? 'unknown'})`).join(', ')}. Those
          proxies contribute no hop, which is not the same as having had no traffic.
        </p>
      )}
    </div>
  );
}
