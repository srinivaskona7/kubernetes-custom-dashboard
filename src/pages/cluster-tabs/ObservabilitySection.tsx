/**
 * Telemetry wiring for one already-known cluster: Prometheus-Operator objects with their scrape
 * and rule verdicts, telemetry pipeline readiness, and OTel agent DaemonSet coverage — one
 * `api.clusterObservability` envelope, no fleet sweep.
 */
import { useCallback, useMemo } from 'react';
import { COLUMN_INFO } from '../../components/table/column-info';
import { api, type ObservabilityData } from '../../api';
import { CENTER, DataTable, type Column } from '../../components/DataTable';
import { CellList, ErrorBanner, Pair, Pill, type Tone } from '../../components/ui';
import {
  Count,
  NotInstalledPanel,
  StatTile,
  UnavailableEmptyBody,
  UnavailableNotice,
  truncatedEntries,
  unavailableEntries,
  unavailableScope
} from '../../components/unavailable';
import { useAsync } from '../../useAsync';

// ------------------------------------------------------------------- collector item shapes
// Read directly off the live collector payload rather than trusted to api.ts's
// deliberately-`unknown` fields.

function resourceTone(state: string): Tone {
  if (state === 'served') return 'ok';
  if (state === 'resourceAbsent') return 'warn';
  return 'unknown';
}

function pipelineTone(verdict: string): Tone {
  if (verdict === 'ready') return 'ok';
  if (verdict === 'notReady') return 'bad';
  return 'unknown';
}

/**
 * The scrape/alert wiring verdicts, as `observability.js`'s `scrapeVerdict` and
 * `alertRuleVerdict` emit them.
 *
 * `NOT_INSTALLED` is deliberately `unknown`-toned rather than `warn`: a cluster that never
 * installed Prometheus-Operator is not misconfigured, and colouring it as a fault would put an
 * amber dot on every cluster that ships telemetry through pipeline resources instead. `UNKNOWN` means
 * an input read failed, so no verdict was formed at all — the collector collapses to it rather
 * than guessing in either direction.
 */
const WIRING_LABEL: Record<string, string> = {
  TARGETS_DECLARED: 'targets declared',
  NO_TARGETS_DECLARED: 'no targets declared',
  RULES_PRESENT: 'rules present',
  NO_RULES: 'no rules',
  NOT_INSTALLED: 'not installed',
  UNKNOWN: 'unknown'
};

function wiringTone(verdict: string): Tone {
  if (verdict === 'TARGETS_DECLARED' || verdict === 'RULES_PRESENT') return 'ok';
  if (verdict === 'NO_TARGETS_DECLARED' || verdict === 'NO_RULES') return 'warn';
  return 'unknown';
}

interface PipelineVerdict {
  name: string | null;
  verdict: 'ready' | 'notReady' | 'indeterminate';
  flowUnhealthy: boolean;
  flowReason: string | null;
  missingConditions: string[];
}

interface PipelineSummary {
  total: number;
  ready: number;
  notReady: number;
  flowUnhealthy: number;
  pipelines: PipelineVerdict[];
}

interface AgentDaemonSet {
  name: string | null;
  namespace: string | null;
  desiredNumberScheduled: number;
  numberReady: number;
  coverageGap: boolean;
}

// -------------------------------------------------------------------------- Observability

export function ObservabilitySection({ id, hidePrometheusOperator = false }: { id: string; hidePrometheusOperator?: boolean }): JSX.Element {
  const observability = useAsync(useCallback(() => api.clusterObservability(id), [id]), 0, id);
  const data = observability.data?.ok ? (observability.data.data as ObservabilityData | undefined) : undefined;

  const scope = useMemo(
    () =>
      unavailableScope({
        clusters: data
          ? [{ id, ok: true, unavailable: unavailableEntries(data.summary), truncated: truncatedEntries(data.summary) }]
          : []
      }),
    [data]
  );
  const telemetryStatus = scope.of('telemetry pipelines', 'logpipelines', 'tracepipelines', 'metricpipelines');
  const agentStatus = scope.of('OTel agent coverage', 'daemonsets');
  // `observability.js` folds `unavailablePaths` (raw API paths, not short labels) into
  // `summary.unavailable`, and `matches()` compares the last path segment — so the plural
  // resource names below match `/apis/monitoring.coreos.com/v1/servicemonitors` as they stand.
  const promStatus = scope.of(
    'Prometheus-Operator objects',
    'prometheuses',
    'servicemonitors',
    'podmonitors',
    'prometheusrules'
  );

  const pipelineKinds: { key: 'logPipelines' | 'tracePipelines' | 'metricPipelines'; label: string }[] = [
    { key: 'logPipelines', label: 'LogPipeline' },
    { key: 'tracePipelines', label: 'TracePipeline' },
    { key: 'metricPipelines', label: 'MetricPipeline' }
  ];

  const pipelineRows = useMemo(() => {
    if (!data) return [];
    return pipelineKinds.flatMap(({ key, label }) => {
      const summary = data.telemetry[key] as unknown as PipelineSummary;
      // A pipeline name is nullable in the collector's shape, so the row's position carries the
      // identity a missing name cannot: two unnamed pipelines of one kind must not share a key.
      return summary.pipelines.map((p, idx) => ({ ...p, kind: label, rowId: `${label}/${p.name ?? 'unnamed'}/${idx}` }));
    });
  }, [data]);

  const totalPipelines = data
    ? pipelineKinds.reduce((n, { key }) => n + ((data.telemetry[key] as unknown as PipelineSummary).total || 0), 0)
    : 0;
  const notReadyCount = data
    ? pipelineKinds.reduce((n, { key }) => n + ((data.telemetry[key] as unknown as PipelineSummary).notReady || 0), 0)
    : 0;
  const flowUnhealthyCount = data
    ? pipelineKinds.reduce((n, { key }) => n + ((data.telemetry[key] as unknown as PipelineSummary).flowUnhealthy || 0), 0)
    : 0;

  const agentRows = (data?.agentCoverage.recognizedAgents as unknown as AgentDaemonSet[] | null) || [];
  const anyAgentRead = Boolean(data && data.agentCoverage.recognizedAgents !== null);
  const agentGapCount = agentRows.filter(a => a.coverageGap).length;

  const discoveryRows = data ? Object.entries(data.prometheusOperator.installed) : [];

  const pipelineColumns: Column<(typeof pipelineRows)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '220px',
      sortValue: p => p.name,
      render: p => <span className="font-medium text-text">{p.name || '—'}</span>
    },
    {
      key: 'kind',
      header: 'Kind',
      max: '150px',
      sortValue: p => p.kind,
      render: p => <span className="text-muted">{p.kind}</span>
    },
    {
      key: 'verdict',
      header: 'Verdict',
      // notReady first, then indeterminate, then ready: the ranking an operator opens this table for.
      sortValue: p => (p.verdict === 'notReady' ? 0 : p.verdict === 'indeterminate' ? 1 : 2),
      render: p => <Pill tone={pipelineTone(p.verdict)}>{p.verdict}</Pill>
    },
    {
      key: 'flow',
      header: 'Flow',
      max: '200px',
      sortValue: p => (p.flowUnhealthy ? 0 : 1),
      render: p =>
        p.flowUnhealthy ? <Pill tone="bad">{p.flowReason || 'unhealthy'}</Pill> : <span className="text-muted">healthy</span>
    },
    {
      key: 'missing',
      header: 'Missing conditions',
      max: '260px',
      sortValue: p => p.missingConditions.length,
      render: p => (
        <span className="mono text-[12px] text-muted">
          <CellList items={p.missingConditions} />
        </span>
      )
    }
  ];

  const agentColumns: Column<AgentDaemonSet>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '220px',
      sortValue: a => a.name,
      render: a => <span className="font-medium text-text">{a.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: a => a.namespace,
      render: a => <span className="text-muted">{a.namespace}</span>
    },
    {
      /*
        One `Ready` column holding `ready / desired`, not two columns holding one number each.

        Split apart, an operator had to read two cells and subtract to learn the only thing either
        number is for. Worse, it made `Ready` mean a bare count here and `ready/desired` in the
        Workloads table — the same label, two facts, two alignments, which is precisely the drift
        `table-alignment.test.js` fails on. `Pair` centres the ratio on its separator, exactly as
        that table does.
      */
      key: 'ready',
      header: 'Ready',
      info: COLUMN_INFO.ready,
      ...CENTER,
      sortValue: a => a.numberReady - a.desiredNumberScheduled,
      render: a => (
        <Pair
          className={a.numberReady < a.desiredNumberScheduled ? 'text-warn' : 'text-muted'}
          a={a.numberReady}
          b={a.desiredNumberScheduled}
          title={`${a.numberReady} of ${a.desiredNumberScheduled} scheduled pods ready`}
        />
      )
    },
    {
      /*
        `Node coverage`, not `Coverage`: the mesh tab's `Coverage` column holds a percentage and is
        right-aligned, and this one holds a gap/covered state. Two alignments under one label is the
        drift `table-alignment.test.js` exists to catch.
      */
      key: 'coverage',
      header: 'Node coverage',
      sortValue: a => (a.coverageGap ? 0 : 1),
      render: a => <Pill tone={a.coverageGap ? 'warn' : 'ok'}>{a.coverageGap ? 'gap' : 'covered'}</Pill>
    }
  ];
  return (
    <section>

      {observability.error && !data && <ErrorBanner code={observability.error.code} message={observability.error.message} />}
      {observability.data && !observability.data.ok && observability.data.error && (
        <ErrorBanner code={observability.data.error.code} message={observability.data.error.message} />
      )}

      {data && (
        <>
          <UnavailableNotice scope={scope} className="mb-3" />

          <div className="mb-4 grid grid-cols-2 gap-4">
            <StatTile
              label="Telemetry Pipelines"
              status={telemetryStatus}
              value={<Count status={telemetryStatus} value={totalPipelines} />}
              caption={`${notReadyCount} not ready · ${flowUnhealthyCount} flow unhealthy`}
              valueClass={notReadyCount > 0 || flowUnhealthyCount > 0 ? 'text-bad' : 'text-text'}
            />
            <StatTile
              label="OTel Agent Coverage"
              status={agentStatus}
              value={anyAgentRead ? <Count status={agentStatus} value={agentGapCount} /> : null}
              caption="DaemonSets with a coverage gap"
              valueClass={agentGapCount > 0 ? 'text-warn' : 'text-text'}
            />
          </div>

          {/*
            The Prometheus-Operator side, in full. This was a one-line pill list of discovery
            states, which showed *whether the CRDs are served* and threw away the four object
            counts and both wiring verdicts sitting right beside them in the same payload.

            All four counts read 0 on a cluster with no Prometheus-Operator, and that is a
            **true** zero, not a failed read — so they are drawn as digits, with the verdict
            underneath saying which of the two it is. `unavailablePaths` is the third case and
            the only one where the digits cannot be trusted: it names the reads that did not
            happen, which is why the counts above it are floors whenever it is non-empty.
          */}
          {!hidePrometheusOperator && data.prometheusOperator && (
            <div className="mb-4 rounded-[8px] border border-line bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <h3 className="text-[13px] font-semibold text-text">Prometheus-Operator</h3>
                {data.prometheusOperator.unavailablePaths.length > 0 && (
                  <span
                    className="border-b border-dashed border-warn/60 pb-px text-[12px] text-warn"
                    tabIndex={0}
                    title={`These reads did not happen, so the counts below are floors: ${data.prometheusOperator.unavailablePaths.join(', ')}`}
                  >
                    {data.prometheusOperator.unavailablePaths.length} read(s) could not be made
                  </span>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 lg:grid-cols-4">
                {(
                  [
                    ['prometheuses', 'Prometheus'],
                    ['servicemonitors', 'ServiceMonitors'],
                    ['podmonitors', 'PodMonitors'],
                    ['prometheusrules', 'PrometheusRules']
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <div className="text-[12px] text-muted">{label}</div>
                    <div className="mono text-[16px] text-text">
                      <Count status={promStatus} value={data.prometheusOperator.counts[key]} size="md" />
                    </div>
                  </div>
                ))}
              </div>

              {/*
                Two verdicts, each with the collector's own reason. Deliberately "targets
                declared", not "scraping": an apiserver-only reader can see that a
                ServiceMonitor object exists, never that Prometheus picked it up — that lives
                in Prometheus's own /targets API, which this console does not reach. Printing
                it as "wired" would be a claim the data cannot support.
              */}
              <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                {(
                  [
                    ['Scrape targets', data.prometheusOperator.scrapeWiring],
                    ['Alert rules', data.prometheusOperator.alertRules]
                  ] as const
                ).map(([label, v]) => (
                  <div key={label} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
                    <span className="w-28 shrink-0 text-muted">{label}</span>
                    <Pill tone={wiringTone(v.verdict)}>{WIRING_LABEL[v.verdict] ?? v.verdict}</Pill>
                    <span className="min-w-0 text-muted">{v.reason ?? '—'}</span>
                  </div>
                ))}
              </div>

              {discoveryRows.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  {discoveryRows.map(([resource, state]) => (
                    <Pill key={resource} tone={resourceTone(state.state)}>
                      {resource}: {state.state}
                    </Pill>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mb-4 rounded-[8px] border border-line bg-surface overflow-hidden">
            <div className="panel-head py-3.5 bg-raised/20">
              <h3 className="text-[15px] font-semibold text-text">Telemetry Pipeline Health</h3>
              <p className="text-[13px] text-muted">
                Ready = GatewayHealthy + ConfigurationGenerated + AgentHealthy all True; Flow Unhealthy is tracked
                separately and can be true even on a Ready pipeline
              </p>
            </div>
            <div className="card-body-flush">
              <DataTable
                id="observability.pipelines"
                columns={pipelineColumns}
                rows={pipelineRows}
                rowKey={p => p.rowId}
                empty={
                  telemetryStatus.state === 'unavailable' ? (
                    <UnavailableEmptyBody status={telemetryStatus} />
                  ) : (
                    <div className="py-6">
                      <NotInstalledPanel
                        what="telemetry pipelines"
                        detail="no LogPipeline, TracePipeline, or MetricPipeline objects found"
                      />
                    </div>
                  )
                }
              />
            </div>
          </div>

          <div className="rounded-[8px] border border-line bg-surface overflow-hidden">
            <div className="panel-head py-3.5 bg-raised/20 flex items-center justify-between">
              <div>
                <h3 className="text-[15px] font-semibold text-text">OTel Agent DaemonSet Coverage</h3>
                <p className="text-[13px] text-muted">DaemonSets running the recognised agent image</p>
              </div>
              <span className="text-[13px] text-muted">{agentGapCount} with a coverage gap</span>
            </div>
            <div className="card-body-flush">
              <DataTable
                id="observability.agents"
                columns={agentColumns}
                rows={agentRows}
                rowKey={a => `${a.namespace}/${a.name}`}
                empty={
                  !anyAgentRead ? (
                    <UnavailableEmptyBody status={agentStatus} />
                  ) : (
                    <div className="py-6">
                      <NotInstalledPanel
                        what="the OTel collector DaemonSet"
                        detail="no DaemonSet running the recognised agent image was found"
                      />
                    </div>
                  )
                }
              />
            </div>
          </div>
        </>
      )}

      {!data && !observability.error && <div className="py-8 text-center text-muted">Loading observability wiring…</div>}
    </section>
  );
}
