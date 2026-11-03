/**
 * Where the access log goes, resolved provider by provider — the one table both log-reading tabs
 * need and neither should own.
 *
 * A Telemetry CR *names* providers; only `istio-system/istio`'s `mesh` key says what each one
 * **is**, and the two common ones are opposites: `stdout-json` (`envoyFileAccessLog` →
 * `/dev/stdout`) lands in the stream `pods/log` returns, while `otel-logs` (`envoyOtelAls` → the
 * OTLP gateway) writes nothing to the pod at all. Without this resolution a tab can only print a
 * provider's name, which tells an operator nothing about why it is empty.
 *
 * Hand-rolled rows rather than a `DataTable`: four short columns, never sorted or filtered.
 */
import type { AccessLogVerdict } from '../../api';
import { Pill } from '../../components/ui';
import { PROVIDER_KIND_WHY } from './access-log';

export function AccessLogProviders({ log }: { log: AccessLogVerdict }): JSX.Element {
  return (
    <>
      {log.providerDetail.length > 0 && (
        <div className="mt-3 divide-y divide-line">
          <div className="flex items-baseline gap-3 py-1.5 text-[11px] uppercase tracking-wide text-muted/70">
            <span className="w-[160px]">Provider</span>
            <span className="w-[76px]">Kind</span>
            <span className="min-w-0 flex-1">Writes to</span>
            <span className="w-[104px] text-right">Readable here</span>
          </div>
          {log.providerDetail.map(p => (
            <div key={p.name} className="flex items-baseline gap-3 py-2 text-[12px]">
              <span className="mono w-[160px] truncate" title={p.implementation ?? 'not declared in the mesh config'}>
                {p.name}
              </span>
              <span className="w-[76px] text-muted" title={PROVIDER_KIND_WHY[p.kind] ?? p.kind}>
                {p.kind}
              </span>
              <span className="mono min-w-0 flex-1 truncate text-muted" title={p.destination ?? undefined}>
                {p.destination ?? '—'}
                {p.fields && <span className="ml-2 text-muted/70">{p.fields} fields</span>}
              </span>
              <span className="w-[104px] text-right">
                <Pill tone={p.readable === true ? 'ok' : p.readable === false ? 'bad' : 'unknown'}>
                  {p.readable === true ? 'yes' : p.readable === false ? 'no' : 'unknown'}
                </Pill>
              </span>
            </div>
          ))}
        </div>
      )}
      {log.meshUnavailable && (
        <p className="mt-2 text-[12px] text-warn">
          The mesh ConfigMap <span className="mono">istio-system/istio</span> could not be read, so no
          provider could be resolved. The tab still tailed the proxies — an unresolved provider is not
          evidence that nothing writes to stdout.
        </p>
      )}
      {log.unresolvedProviders.length > 0 && !log.meshUnavailable && (
        <p className="mt-2 text-[12px] text-warn">
          The mesh config declares no <span className="mono">extensionProviders</span> entry named{' '}
          <span className="mono">{log.unresolvedProviders.join(', ')}</span>, so Envoy may be dropping
          the log on the floor — or the provider is defined somewhere this reader cannot see.
        </p>
      )}
      {log.decidedBy.length > 0 && (
        <div className="mt-4 divide-y divide-line border-t border-line pt-1">
          {/*
            Two different lists sit under this heading — what the providers *are* (above) and which
            CRs *chose* them (here). Unlabelled they read as one table with a stray row, so the
            second gets its own caption and a rule above it.
          */}
          <div className="py-1.5 text-[11px] uppercase tracking-wide text-muted/70">Decided by</div>
          {log.decidedBy.map(d => (
            <div key={`${d.namespace}/${d.name}`} className="flex items-baseline gap-3 py-2 text-[12px]">
              <span className="mono">
                {d.namespace}/{d.name}
              </span>
              <Pill tone={d.scope === 'mesh' ? 'accent' : 'unknown'}>{d.scope}</Pill>
              <span className="mono text-muted">{d.providers.join(', ') || 'no provider'}</span>
              {d.selector && (
                <span
                  className="text-muted"
                  title="This CR carries a workload selector, so it applies only to matching workloads — a workload missing from this tab may simply not be logging."
                >
                  selector-scoped
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
