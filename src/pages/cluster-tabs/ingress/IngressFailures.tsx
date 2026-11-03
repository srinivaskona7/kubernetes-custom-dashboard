/**
 * Ingress & Traffic → Failure analysis.
 *
 * What the edge actually answered, and why — owner first. The failures are bucketed by who owns
 * them (the app failed, nothing routed the path, a policy refused it, TLS turned it away) and the two
 * the operator owns lead, with the upstream clusters they were aimed at. The code breakdown and the
 * decoded response flags follow.
 *
 * ## Two questions, not one
 *
 * An operator arriving here has one of two questions, and they have different answers:
 *
 *   - *"what did clients get back?"* — the response codes. `403` on 574 of 1175 requests is not a
 *     cluster fault; it is an authorisation policy doing its job against something that kept asking.
 *   - *"why did Envoy do that?"* — the response flags. This is the half that is normally unreadable,
 *     because `%RESPONSE_FLAGS%` is a two-to-three letter code with no legend in the log line. `NR`
 *     means "no route", `UAEX` means "denied by an ext_authz filter", `DPE` means the downstream sent
 *     a protocol error. Printing the letters and not the sentence would leave the operator to go and
 *     look them up, which is the work this screen exists to do.
 *
 * Neither number is a rate. The window is a tail of the access log, so everything here is "of the
 * lines that were read" — and that is said on the screen rather than implied.
 *
 * ## What is deliberately not here
 *
 * The TLS rejections — `response_code: 0` with `filter_chain_not_found` — were the single largest
 * failure bucket on the live cluster, and they are on the **TLS & Listeners** screen instead. They are
 * not HTTP failures: no request was ever parsed, so they have no method, no path and no host, and
 * mixing them into a code table would make `0` the biggest "response code" on a healthy cluster. The
 * link at the bottom of this screen is how an operator gets from here to there.
 */
import { useMemo } from 'react';
import type { IngressFlag, TrafficErrorGroup, TrafficIngress } from '../../../api';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { COLUMN_INFO } from '../../../components/table/column-info';
import { Btn, Dot, Empty, InfoTip, Pill, type Tone } from '../../../components/ui';
import { ago } from '../../../format';
import { IngressCard, IngressGap, Num } from './parts';
import { exactTimestamp, ingressWasRead, share } from './shared';
import { BUCKET_LABEL, BUCKET_TONE, BUCKET_WHY, bucketFailures, failingUpstreams, failureBucketState, notFromServer } from './edge-view';
import { Unavailable, type MetricStatus } from '../../../components/unavailable';

type UpstreamRow = ReturnType<typeof failingUpstreams>[number];

export function IngressFailures({
  ingress,
  errors,
  onShowCode,
  onShowFlag,
  onShowListeners,
  onShowFailures,
  notRead
}: {
  ingress: TrafficIngress | undefined;
  /** The failing-request groups (`payload.errors`); their `bucket` is what the owner summary counts. */
  errors: TrafficErrorGroup[] | undefined;
  onShowCode: (code: number) => void;
  onShowFlag: (flag: string) => void;
  onShowListeners: () => void;
  /** Opens the bucketed failing-requests list. */
  onShowFailures: () => void;
  /** Set when no request log was proved readable (`accessLogEvidence`); an empty list then proves nothing. */
  notRead?: MetricStatus | null;
}): JSX.Element {
  const s = ingress?.summary;
  const codes = useMemo(() => [...(s?.byCode ?? [])].sort((a, b) => b.count - a.count), [s?.byCode]);
  const flags = ingress?.flags ?? [];
  const bucketState = failureBucketState(errors, !!notRead);
  const bucketed = bucketState === 'bucketed';
  const buckets = useMemo(() => bucketFailures(errors ?? []), [errors]);
  const upstreams = useMemo(() => failingUpstreams(errors ?? []), [errors]);

  if (!ingressWasRead(ingress)) return <IngressGap ingress={ingress} />;

  const codeTotal = codes.reduce((n, c) => n + c.count, 0);
  const failing = codes.filter(c => c.class === 'client' || c.class === 'server' || c.class === 'no-response');

  const upstreamColumns: Column<UpstreamRow>[] = [
    {
      key: 'target',
      header: 'Upstream target',
      pin: true,
      max: '380px',
      sortValue: u => u.target,
      render: u => (
        <span className="mono block truncate text-[12px]" title={u.target}>
          {u.target}
        </span>
      )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '88px',
      sortValue: u => u.requests,
      render: u => <Num value={u.requests} tone="bad" title="Failing app requests aimed at this Envoy cluster, of the lines read." />
    },
    {
      key: 'codes',
      header: 'Codes',
      max: '150px',
      sortValue: u => u.codes[0] ?? null,
      render: u => <span className="mono truncate text-[12px]">{u.codes.map(c => (c === 0 ? '0' : c)).join(' ') || '—'}</span>
    },
    {
      key: 'flags',
      header: 'Flags',
      max: '150px',
      sortValue: u => u.flags[0] ?? null,
      render: u => <span className="mono truncate text-[12px]">{u.flags.join(' ') || '—'}</span>
    },
    {
      key: 'hosts',
      header: 'Hosts',
      // Sheds under 900px so the target, count, codes and flags fit the narrow pane.
      priority: 3,
      max: '260px',
      sortValue: u => u.hosts[0] ?? null,
      render: u => (
        <span className="mono truncate text-[12px] text-muted" title={u.hosts.join('\n') || undefined}>
          {u.hosts.join(', ') || '—'}
        </span>
      )
    }
  ];

  const flagColumns: Column<IngressFlag>[] = [
    {
      key: 'flag',
      header: 'Flag',
      pin: true,
      width: '92px',
      sortValue: f => f.flag,
      render: f => (
        <span className="inline-flex items-center gap-1.5">
          <Dot tone={flagTone(f)} />
          <span className="mono text-[12px] font-semibold">{f.flag}</span>
        </span>
      )
    },
    {
      key: 'meaning',
      header: 'Meaning',
      max: '280px',
      sortValue: f => f.name ?? f.flag,
      render: f =>
        f.known ? (
          <span className="min-w-0" title={f.meaning ?? undefined}>
            <span className="truncate text-[13px]">{f.name}</span>
          </span>
        ) : (
          <span
            className="truncate text-[12px] italic text-muted"
            title={`Envoy emitted ${f.flag} and this console's table of response flags does not have it. That is a gap in this build, not a new failure mode — Envoy's own docs list every flag it can emit.`}
          >
            not in this build’s table
          </span>
        )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '88px',
      sortValue: f => f.count,
      render: f => (
        <Num
          value={f.count}
          tone={flagTone(f) === 'bad' ? 'bad' : 'warn'}
          title={`${f.count} of the ${s?.records.toLocaleString() ?? '?'} lines read carried ${f.flag}. One line can carry more than one flag, so these do not sum to the records read.`}
        />
      )
    },
    {
      key: 'codes',
      header: 'Codes',
      max: '150px',
      sortValue: f => f.codes[0]?.code ?? null,
      render: f => (
        <span className="mono truncate text-[12px]" title={f.codes.map(c => `${c.code === 0 ? 'no response' : c.code} ×${c.count}`).join(', ')}>
          {f.codes.length ? f.codes.map(c => (c.code === 0 ? '0' : c.code)).join(' ') : '—'}
        </span>
      )
    },
    {
      key: 'hosts',
      header: 'Distinct hosts',
      // Sheds under 900px; the Envoy detail says more about a flag than its host count does.
      priority: 3,
      ...NUMERIC,
      width: '110px',
      sortValue: f => f.hosts,
      render: f => (
        <Num
          value={f.hosts}
          title={
            f.hosts === 0
              ? 'No line carrying this flag had a Host header — which for a connection-level flag is expected, because no request was ever parsed.'
              : `${f.hosts} distinct host value${f.hosts === 1 ? '' : 's'} saw this flag. One host means it is localised; many means it is the listener.`
          }
        />
      )
    },
    {
      key: 'detail',
      header: 'Envoy’s detail',
      info: COLUMN_INFO.ingressFlagDetail,
      max: '220px',
      sortValue: f => f.details[0] ?? null,
      render: f => (
        <span className="mono truncate text-[12px] text-muted" title={f.details.join('\n') || undefined}>
          {f.details.join(', ') || '—'}
        </span>
      )
    },
    {
      key: 'last',
      header: 'Last seen',
      ...NUMERIC,
      priority: 3,
      width: '104px',
      sortValue: f => f.lastSeen,
      render: f => <span className="text-[12px] text-muted" title={exactTimestamp(f.lastSeen)}>{f.lastSeen ? ago(f.lastSeen) : '—'}</span>
    }
  ];

  return (
    <div className="space-y-5">
      <IngressCard
        title="Failures by owner"
        hint="Every failing request in one bucket, decided by the server from the edge class and Envoy's own verdict. The two you own lead; policy refusals, TLS rejections and requests dialled by IP or an unknown host are collapsed after them."
      >
        {bucketState === 'unread' ? (
          <p className="text-[13px]">
            <Unavailable what="Failure buckets" why="the failing-requests read has not answered; the page-level notice names why if it failed" />
          </p>
        ) : bucketState === 'unproven' ? (
          <p className="text-[13px]">
            <Unavailable what="Failure buckets" why={notRead?.why} />
          </p>
        ) : bucketState === 'empty' ? (
          <Empty title="No failing request in this window" hint="No 4xx, 5xx or unanswered connection was among the lines read. Widen the window or re-read." />
        ) : bucketState === 'legacy' ? (
          <p className="text-[13px]">
            <Unavailable what="Failure buckets" why={notFromServer('Failure buckets').why} />
          </p>
        ) : (
          <div className="divide-y divide-line">
            {buckets.map(b => {
              const tone: Tone = b.bucket === 'unclassified' ? 'unknown' : BUCKET_TONE[b.bucket];
              return (
                <div key={b.bucket} className="flex items-baseline gap-3 py-2">
                  <span className="w-[200px] shrink-0 whitespace-nowrap">
                    <Pill tone={tone}>{b.bucket === 'unclassified' ? 'Unclassified' : BUCKET_LABEL[b.bucket]}</Pill>
                  </span>
                  <span className="mono w-[84px] shrink-0 text-right text-[13px]">{b.requests.toLocaleString()}</span>
                  <span className="mono w-[84px] shrink-0 text-right text-[12px] text-muted">{b.groups.length} distinct</span>
                  <span className="min-w-0 flex-1 text-[12px] text-muted">
                    {b.bucket === 'unclassified' ? 'Failures the server sent without a bucket — mesh sidecar lines, or an older srv.' : BUCKET_WHY[b.bucket]}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </IngressCard>

      {bucketed && (
        <IngressCard
          title="Failing upstream targets"
          label={String(upstreams.length)}
          hint="The Envoy cluster each app-failed or not-routed request was sent to, busiest first. No upstream chosen means Envoy found no route or no healthy endpoint to ask."
        >
          <DataTable
            columns={upstreamColumns}
            rows={upstreams}
            rowKey={u => u.target}
            onSelect={onShowFailures}
            empty={<Empty title="No app request failed in this window" hint="Every failure read was a policy refusal or a TLS rejection, which the edge is meant to produce." />}
          />
        </IngressCard>
      )}

      <IngressCard
        title="What the edge answered"
        label={`${codeTotal.toLocaleString()} records`}
        hint="Every response code the ingress gateway returned in the window that was read. A failing code is clickable — it opens the individual requests behind it."
      >
        {codes.length === 0 ? (
          <Empty
            title="No response code was recorded"
            hint="The lines that were read carried no status field. Proxies read, beside the sub-tabs, shows which access-log provider is configured and what its lines look like."
          />
        ) : (
          <div className="divide-y divide-line">
            {codes.map(c => {
              const pct = codeTotal > 0 ? c.count / codeTotal : null;
              const tone = classTone(c.class);
              /*
                Only a failing code is clickable, and that is not a styling choice.
                `payload.errors` — the list the deep link lands in — holds *failures only*, so a
                clickable `200` would open a table that says "no failing request matches 200". True,
                and read as a bug in the link. The 2xx row is the largest one on a healthy cluster, so
                this is the affordance most likely to be tried first.
              */
              const linkable = c.class === 'client' || c.class === 'server' || c.class === 'no-response';
              const label = c.code === 0 ? 'no response' : String(c.code);
              const body = (
                <>
                  <span className="mono w-[52px] shrink-0 text-[13px] font-semibold">
                    {c.code === 0 ? '—' : c.code}
                  </span>
                  <span className="w-[170px] shrink-0 whitespace-nowrap">
                    <Pill tone={tone} title={CLASS_WHY[c.class] ?? 'This console has no description for that response class.'}>
                      {CLASS_LABEL[c.class] ?? c.class}
                    </Pill>
                  </span>
                  <span className="hidden min-w-0 flex-1 md:block">
                    <span className="block h-1.5 overflow-hidden rounded-full bg-line">
                      <span
                        className={`block h-full rounded-full ${barClass(tone)}`}
                        style={{ width: `${Math.max(pct === null ? 0 : pct * 100, 1.5)}%` }}
                      />
                    </span>
                  </span>
                  <span className="mono w-[84px] shrink-0 text-right text-[13px]">{c.count.toLocaleString()}</span>
                  <span className="mono w-[56px] shrink-0 text-right text-[12px] text-muted">{share(pct)}</span>
                </>
              );
              const why = `${c.count.toLocaleString()} record${c.count === 1 ? '' : 's'} — ${share(pct)} of what was read.`;
              return linkable ? (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => onShowCode(c.code)}
                  className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-line/30"
                  title={`${why} Opens the failing-requests list filtered to ${label}.`}
                >
                  {body}
                </button>
              ) : (
                <div key={c.code} className="flex w-full items-center gap-3 py-2" title={why}>
                  {body}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 max-w-[100ch] text-[12px] text-muted">
          {CODE_NOTE}
        </p>
      </IngressCard>

      {failing.length > 0 && (
        <IngressCard
          title="The codes worth a look"
          hint="What each failing code means at an ingress gateway specifically — the same number has a different cause at the edge than it does between two services."
        >
          <div className="grid gap-2 md:grid-cols-2">
            {failing.map(c => (
              <div key={c.code} className="rounded-[8px] border border-line bg-surface px-3 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[14px] font-semibold">{c.code === 0 ? 'no response' : c.code}</span>
                  <span className="mono text-[12px] text-muted">×{c.count.toLocaleString()}</span>
                  <span className="ml-auto">
                    <Btn onClick={() => onShowCode(c.code)} title={`Open the failing-requests list filtered to ${c.code}.`}>
                      Show requests
                    </Btn>
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-muted">
                  {CODE_MEANING[c.code] ?? GENERIC_MEANING[c.class] ?? 'This console has no note for that code.'}
                </p>
              </div>
            ))}
          </div>
        </IngressCard>
      )}

      <IngressCard
        title="Why Envoy did that"
        label={String(flags.length)}
        hint="Envoy's own verdict on each connection, decoded. Click a flag for the requests that carried it. One line can carry more than one flag, so these counts do not sum to the records read."
        action={<InfoTip text="`%RESPONSE_FLAGS%` is the field that distinguishes a 503 the upstream returned from a 503 Envoy returned because there was no healthy upstream to ask. Without it a code table cannot tell you which half of the mesh to look at." />}
      >
        {/*
          Seven columns and nothing wide: the base tier is right. Its 900px priority-3 threshold sits
          below this console's ~1090px container at 1440, so `Last seen` is there at the default width
          and is the first thing to go when the window narrows — which is correct, because a flag's
          recency matters less than its count.
        */}
        <DataTable
          columns={flagColumns}
          rows={flags}
          rowKey={f => f.flag}
          onSelect={f => onShowFlag(f.flag)}
          empty={
            <Empty
              title="No line carried a response flag"
              hint="Every request in the window completed without Envoy adding a verdict of its own — which on an ingress gateway is the good case."
            />
          }
        />
        <p className="mt-3 max-w-[100ch] text-[12px] text-muted">
          A flag is not automatically a fault. <span className="mono">DC</span> means the client hung up,
          which people do; <span className="mono">DPE</span> means something spoke bad HTTP at the listener, which
          scanners do constantly. What makes a flag a finding is its share of a real host's traffic — so the
          row to act on is usually the one whose count is large next to a host you recognise on the{' '}
          <span className="italic">Hosts &amp; TLS</span> screen.
        </p>
      </IngressCard>

      <IngressCard
        title="Connections that never became requests"
        hint="TLS connections turned away before routing with filter_chain_not_found have no method, no path and no host, because no request was ever parsed. They are counted per listener and per SNI name on Hosts & TLS rather than folded in above, where 0 would otherwise be the largest “response code” on a perfectly healthy cluster."
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <Dot tone="unknown" />
          <span className="min-w-0 flex-1 text-[13px] text-muted">TLS rejections are counted per listener and SNI on Hosts &amp; TLS, not in the codes above.</span>
          <Btn onClick={onShowListeners}>Open Hosts &amp; TLS</Btn>
        </div>
      </IngressCard>
    </div>
  );
}

/**
 * Which colour a response flag earns — **derived from the codes it actually carried**, not from a
 * hand-kept list of "bad" flags.
 *
 * A list would go stale the moment Envoy adds a flag, and it would also be wrong about the ones that
 * cut both ways: `UT` (upstream timeout) is a genuine fault, while `DC` (downstream disconnect) is a
 * person closing a tab. Reading the class off the codes means a flag that only ever appeared beside
 * 4xx is amber and one that appeared beside a 5xx is red, which is the same rule the rest of this
 * screen uses. A flag this build cannot name is `unknown`: the gap is in the console, not the cluster.
 */
function flagTone(f: IngressFlag): Tone {
  if (!f.known) return 'unknown';
  if (f.codes.some(c => c.class === 'server')) return 'bad';
  if (f.codes.some(c => c.class === 'client')) return 'warn';
  return 'unknown';
}

/** Which colour a response class earns. `no-response` is `unknown`, not `bad` — see {@link CLASS_WHY}. */
function classTone(klass: string): Tone {  if (klass === 'server') return 'bad';
  if (klass === 'client') return 'warn';
  if (klass === 'no-response') return 'unknown';
  if (klass === 'redirect') return 'unknown';
  if (klass === 'ok') return 'ok';
  return 'unknown';
}

/** The bar fill for a tone. Kept beside {@link classTone} so a new class cannot get a bar with no colour. */
function barClass(tone: Tone): string {
  if (tone === 'bad') return 'bg-bad';
  if (tone === 'warn') return 'bg-warn';
  if (tone === 'ok') return 'bg-ok';
  return 'bg-muted/40';
}

const CLASS_LABEL: Record<string, string> = {
  ok: 'Answered',
  redirect: 'Redirected',
  client: 'Rejected by the edge',
  server: 'Failed behind the edge',
  'no-response': 'No response sent'
};

const CLASS_WHY: Record<string, string> = {
  ok: 'The gateway routed the request and the upstream answered 2xx.',
  redirect: 'A 3xx. On an ingress gateway this is usually the HTTPS redirect on the plain-HTTP listener, which is the Gateway working.',
  client:
    'A 4xx. The request reached the gateway and was turned away — by an authorisation policy, by a missing route, or because the request itself was malformed. Not a cluster fault on its own.',
  server:
    'A 5xx. Either the upstream answered with one, or Envoy produced one because it had nothing healthy to ask. The response flag beside it is what tells the two apart, and it is the one class here that always deserves a look.',
  'no-response':
    'No HTTP status was ever written: the connection was closed before a response. Usually a TLS handshake that matched no listener, which is counted per SNI name on the Hosts & TLS screen.'
};

/** What each failing code means **at an ingress gateway**, which is not what it means between two services. */
const CODE_MEANING: Record<number, string> = {
  0: 'The connection closed before any response was written. At the edge this is almost always a TLS handshake that matched no filter chain — see the Hosts & TLS screen for which SNI names were offered.',
  400: 'Envoy could not parse the request. At a public listener this is overwhelmingly scanners and probes speaking something that is not HTTP; the DPE response flag beside it is the confirmation.',
  401: 'Authentication was required and was missing or failed. Produced by the gateway, not the workload, so the request never reached the service — check the RequestAuthentication or AuthorizationPolicy that declares the requirement.',
  403: 'Authenticated but not permitted, or refused outright by an authorisation policy. Envoy adds UAEX when an ext_authz filter made the call. A large steady count against one host is a policy working against something that keeps asking, not an outage.',
  404: 'No route matched the host and path. The Gateway admitted the name but nothing published a route for that path — the Hosts & TLS screen shows which VirtualService, Ingress or HTTPRoute, if any, declares this host.',
  429: 'Rate-limited before reaching the upstream. The limit is declared in the mesh, so the number to compare it against is the request count for the same host.',
  500: 'The upstream returned it. Envoy passed it through unchanged, so the fault is in the workload, not at the edge.',
  502: 'The upstream answered in a way Envoy could not use, or the connection to it broke mid-response. The upstream_transport_failure_reason detail says which.',
  503: 'Either the upstream returned it, or — more commonly at the edge — Envoy had no healthy endpoint to send to. UH (no healthy upstream) or UF (connection failure) in the flag column is what separates a workload problem from a routing one.',
  504: 'The upstream did not answer inside the route timeout. Compare the upstream latency on the Hosts & TLS screen: a p95 close to the timeout means this will recur.'
};

/** The fallback when a code is failing but not one this console annotates. Keyed by class, so it is never blank. */
const GENERIC_MEANING: Record<string, string> = {
  client: 'A 4xx the gateway produced or passed through. The request arrived and was not served.',
  server: 'A 5xx. Either the upstream produced it or Envoy did on the upstream’s behalf; the response flag says which.',
  'no-response': 'No status was written before the connection closed.'
};

const CODE_NOTE =
  'Counts are of the access-log lines that were read, not of all traffic — this is a tail of the log, so a code absent here may simply not have occurred inside the window. Shares are of that same sample, which is why they are labelled as a share of what was read rather than as an error rate for the cluster.';
