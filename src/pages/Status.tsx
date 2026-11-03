/**
 * Status — what this deployment is: the running version, how many clusters it knows, and how it
 * authenticates its readers. One read of `/api/status`, which deliberately carries nothing from
 * the app config, rendered with the console's CSS variables so it honors both themes.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PageProps } from '../App';
import type { AppStatusResponse } from '../api';
import { PageBody, PageHeader } from '../components/layout';
import { Btn, Card, Pill } from '../components/ui';

const formatDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const AUTH_LABEL: Record<AppStatusResponse['authMode'], string> = {
  oidc: 'OIDC sign-in',
  none: 'none (development)'
};

export default function Status({ onRefreshed }: PageProps) {
  const [data, setData] = useState<AppStatusResponse | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
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
          const at = new Date().toISOString();
          setData(json);
          setCheckedAt(at);
          onRefreshed(at);
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

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Status" icon="security" subtitle="This deployment's version, fleet size and sign-in mode" />

      <PageBody className="space-y-4 pb-8">
        {error && (
          <div className="rounded-[6px] border border-bad/40 bg-bad/10 px-4 py-3 text-[13px] text-bad">
            {error.message}
          </div>
        )}

        <Card>
          {loading && !data ? (
            <div className="text-[13px] text-muted">Checking deployment status…</div>
          ) : (
            data && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Pill tone={data.ok ? 'ok' : 'bad'}>{data.ok ? 'Healthy' : 'Failing'}</Pill>
                  <span className="text-[13.5px] text-text">The dashboard server answered.</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-muted">Checked {formatDate(checkedAt)}</span>
                  <Btn onClick={() => load()} disabled={loading}>
                    <span aria-hidden="true">↻</span>
                    {loading ? 'Refreshing…' : 'Refresh'}
                  </Btn>
                </div>
              </div>
            )
          )}
        </Card>

        {data && (
          <Card title="Runtime">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-[13px] md:grid-cols-2">
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Version:</dt>
                <dd className="mono text-text">{data.version || '—'}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Clusters registered:</dt>
                <dd className="text-text">{data.clusters ?? '—'}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-muted">Authentication:</dt>
                <dd className="text-text">{AUTH_LABEL[data.authMode] ?? data.authMode}</dd>
              </div>
            </dl>
          </Card>
        )}
      </PageBody>
    </div>
  );
}
