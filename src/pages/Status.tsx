/**
 * Status — follows the exact layout, logic, field labels, and helper functions of `main`'s
 * `src/pages/Status.jsx` template (`STATUS_TAGS`, `STATE_TAGS`, `formatDate`, `formatRemaining`,
 * `Mono` with copy-to-clipboard, `LeafCard` 10-row bordered descriptions table,
 * `Chain and trust bundle` table with `Source`, `Common name`, `Issuer`, `Valid to`, `State`,
 * and `Runtime` 2-column descriptions card), rendered with the console's CSS variables so it
 * honors both dark and light themes without adding external UI library dependencies.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PageProps } from '../App';
import type { AppStatusResponse, NarrativeCertificate, NarrativeStatus } from '../api';
import { PageBody, PageHeader } from '../components/layout';
import { Btn, Card, Pill, type Tone } from '../components/ui';

const STATUS_TAGS: Record<NarrativeStatus['status'], { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'Healthy' },
  warn: { tone: 'warn', label: 'Expiring' },
  fail: { tone: 'bad', label: 'Failing' },
  missing: { tone: 'unknown', label: 'Not mounted' }
};

const STATE_TAGS: Record<NarrativeCertificate['state'], Tone> = {
  valid: 'ok',
  expiring: 'warn',
  expired: 'bad',
  'not-yet-valid': 'bad'
};

const formatDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function formatRemaining(hours?: number | null) {
  if (hours == null) return '—';
  if (hours <= 0) return 'expired';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

function Mono({ children, copyable = true }: { children?: ReactNode; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!children) return <>—</>;
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : '';

  const onCopy = () => {
    if (!text || !navigator?.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" style={{ wordBreak: 'break-all' }}>
      <code className="mono rounded-[4px] border border-line bg-raised px-1.5 py-0.5 text-[12.5px] text-text">
        {children}
      </code>
      {copyable && text && (
        <button
          type="button"
          onClick={onCopy}
          title={copied ? 'Copied' : 'Copy to clipboard'}
          aria-label={copied ? 'Copied' : 'Copy to clipboard'}
          className="rounded px-1 text-[11px] text-muted hover:bg-raised hover:text-text"
        >
          {copied ? '✓' : 'Copy'}
        </button>
      )}
    </span>
  );
}

function LeafCard({ leaf, keyMatches }: { leaf: NarrativeCertificate; keyMatches: boolean | null }) {
  const rows: { label: string; value: ReactNode }[] = [
    { label: 'Common name (CN)', value: <Mono>{leaf.commonName}</Mono> },
    {
      label: 'APRN',
      value: leaf.aprns.length ? (
        <div className="flex flex-col gap-1">
          {leaf.aprns.map(a => (
            <Mono key={a}>{a}</Mono>
          ))}
        </div>
      ) : (
        '—'
      )
    },
    {
      label: 'State',
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Pill tone={STATE_TAGS[leaf.state] ?? 'unknown'} size="sm">
            {leaf.state}
          </Pill>
          <span className="text-[13px] text-muted">{formatRemaining(leaf.hoursRemaining)} remaining</span>
        </span>
      )
    },
    { label: 'Valid from', value: formatDate(leaf.validFrom) },
    { label: 'Valid to', value: formatDate(leaf.validTo) },
    {
      label: 'Private key',
      value:
        keyMatches == null ? (
          <span className="text-muted">not checked</span>
        ) : (
          <Pill tone={keyMatches ? 'ok' : 'bad'} size="sm">
            {keyMatches ? 'matches certificate' : 'does not match'}
          </Pill>
        )
    },
    { label: 'Issuer', value: <Mono>{leaf.issuerCommonName || leaf.issuer}</Mono> },
    { label: 'Subject', value: <Mono>{(leaf.subject || '').split(String.fromCharCode(10)).join(', ')}</Mono> },
    {
      label: 'Subject alt names',
      value: leaf.subjectAltNames?.length ? (
        <div className="flex flex-col gap-1">
          {leaf.subjectAltNames.map(s => (
            <span key={`${s.type}:${s.value}`} className="inline-flex flex-wrap items-center gap-1.5">
              <span className="rounded-[4px] border border-line bg-raised px-1.5 py-px text-[12px] text-muted">
                {s.type}
              </span>
              <Mono copyable={false}>{s.value}</Mono>
            </span>
          ))}
        </div>
      ) : (
        '—'
      )
    },
    { label: 'Serial number', value: <Mono>{leaf.serialNumber}</Mono> },
    { label: 'SHA-256 fingerprint', value: <Mono>{leaf.fingerprint256}</Mono> }
  ];

  return (
    <Card title="Identity certificate" flush>
      <dl className="divide-y divide-line text-[13px]">
        {rows.map(row => (
          <div key={row.label} className="grid grid-cols-1 sm:grid-cols-[180px_1fr]">
            <dt className="panel-head bg-raised/40 py-2.5 font-medium text-muted sm:border-r sm:border-line">
              {row.label}
            </dt>
            <dd className="panel-head py-2.5 text-text">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default function Status({ onRefreshed }: PageProps) {
  const [data, setData] = useState<AppStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      fetch(`${base}/api/status`, { signal, credentials: 'same-origin' })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<AppStatusResponse>;
        })
        .then(json => {
          setData(json);
          if (json?.checkedAt) onRefreshed(json.checkedAt);
        })
        .catch((err: Error) => {
          if (err.name !== 'AbortError') setError(err);
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [base, onRefreshed]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const narrative = data?.narrative;
  const tag =
    narrative &&
    (STATUS_TAGS[narrative.status] ?? {
      tone: 'unknown' as Tone,
      label: narrative.status || 'Unknown'
    });

  const chainRows = [
    ...(narrative?.chain || []).map((c, i) => ({ ...c, source: 'tls.crt', key: `tls-${i}` })),
    ...(narrative?.ca || []).map((c, i) => ({ ...c, source: 'ca.crt', key: `ca-${i}` }))
  ];

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title="Status"
        icon="security"
        subtitle="Narrative identity certificate mounted at /tls"
      />

      <PageBody className="space-y-4 pb-8">
        {error && (
          <div className="rounded-[6px] border border-bad/40 bg-bad/10 px-4 py-3 text-[13px] text-bad">
            {error.message}
          </div>
        )}

        <Card>
          {loading && !data ? (
            <div className="text-[13px] text-muted">Checking Narrative identity status…</div>
          ) : (
            narrative &&
            tag && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Pill tone={tag.tone}>{tag.label}</Pill>
                  <span className="text-[13.5px] text-text">{narrative.detail}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-muted">Checked {formatDate(data?.checkedAt)}</span>
                  <Btn onClick={() => load()} disabled={loading}>
                    <span aria-hidden="true">↻</span>
                    {loading ? 'Refreshing…' : 'Refresh'}
                  </Btn>
                </div>
              </div>
            )
          )}
        </Card>

        {narrative?.caError && (
          <div className="rounded-[6px] border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn">
            {narrative.caError}
          </div>
        )}

        {narrative?.leaf && <LeafCard leaf={narrative.leaf} keyMatches={narrative.keyMatches} />}

        {narrative && chainRows.length > 0 && (
          <Card title="Chain and trust bundle" flush>
            <div className="divide-y divide-line text-[13px]">
              <div className="panel-head grid grid-cols-1 gap-3 bg-raised/40 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted sm:grid-cols-[110px_1fr_1fr_200px_130px]">
                <div>Source</div>
                <div>Common name</div>
                <div>Issuer</div>
                <div>Valid to</div>
                <div>State</div>
              </div>
              {chainRows.map(row => (
                <div
                  key={row.key}
                  className="panel-head grid grid-cols-1 items-center gap-3 py-2.5 sm:grid-cols-[110px_1fr_1fr_200px_130px]"
                >
                  <div className="mono text-[12.5px] text-muted">{row.source}</div>
                  <div className="mono truncate text-text" title={row.commonName || row.subject}>
                    {row.commonName || row.subject}
                  </div>
                  <div className="mono truncate text-muted" title={row.issuerCommonName || row.issuer}>
                    {row.issuerCommonName || '—'}
                  </div>
                  <div className="text-muted">{formatDate(row.validTo)}</div>
                  <div>
                    <Pill tone={STATE_TAGS[row.state] ?? 'unknown'} size="sm">
                      {row.state}
                    </Pill>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {data && (
          <Card title="Runtime">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-[13px] md:grid-cols-2">
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Namespace:</dt>
                <dd className="text-text">{data.runtime?.namespace || '—'}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Pod:</dt>
                <dd className="text-text">{data.runtime?.pod || '—'}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Environment:</dt>
                <dd className="text-text">{data.runtime?.nodeEnv}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="shrink-0 text-muted">Whisper loaded:</dt>
                <dd>
                  <Pill tone={data.whisper.loaded ? 'ok' : 'unknown'} size="sm">
                    {data.whisper.loaded ? 'yes' : 'no'}
                  </Pill>
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Certificate path:</dt>
                <dd className="min-w-0">
                  <Mono copyable={false}>{narrative?.paths?.certPath}</Mono>
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">CA path:</dt>
                <dd className="min-w-0">
                  <Mono copyable={false}>{narrative?.paths?.caPath}</Mono>
                </dd>
              </div>
            </dl>
          </Card>
        )}
      </PageBody>
    </div>
  );
}
