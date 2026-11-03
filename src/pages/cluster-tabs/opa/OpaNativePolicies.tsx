/**
 * Native policies — the cluster's built-in ValidatingAdmissionPolicies, joined to their bindings.
 *
 * Kubernetes' own CEL admission policies are a second policy engine beside Gatekeeper, and on a
 * Kyma cluster they are usually the one doing more: the modules ship them. Before this tab the
 * console counted them in one strip and listed none, so an operator could see "11" and not which
 * eleven, who owns them, or whether any of them is declared and bound to nothing.
 *
 * The rows arrive as a prop from the Security tab's `clusterPolicy` read — no request of its own —
 * and carry no CEL: the server ships each validation's `message` and never its `expression`.
 */
import { useMemo, useState } from 'react';
import type { NativePolicies, NativePolicy } from '../../../api';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { DetailPanel, Field, Section } from '../../../components/layout';
import { Empty, Pill, Skeleton } from '../../../components/ui';
import { Count, UnavailableEmptyBody, type MetricStatus } from '../../../components/unavailable';
import { FilterBar, FilterSelect, SearchBox } from '../../../components/filters';
import { NATIVE_STATUS, bindingScopeLine, bindingsLine, byNativeRisk, countByStatus, targetLine, targetParts } from './native-policies';

type Status = NativePolicy['effectiveStatus'];

export function OpaNativePolicies({
  native,
  status,
  loading
}: {
  /** null while the Security section's `clusterPolicy` read is in flight or failed. */
  native: NativePolicies | null;
  /** The ValidatingAdmissionPolicy and binding reads, together — a row needs both. */
  status: MetricStatus;
  loading: boolean;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [effective, setEffective] = useState<'all' | Status>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const all = useMemo(() => native?.policies ?? [], [native]);
  const counts = useMemo(() => countByStatus(all), [all]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter(p => effective === 'all' || p.effectiveStatus === effective)
      .filter(p => !needle || `${p.name} ${p.owner ?? ''} ${p.module ?? ''} ${targetLine(p)} ${p.messages.join(' ')}`.toLowerCase().includes(needle))
      .sort(byNativeRisk);
  }, [all, effective, q]);
  const current = selected ? all.find(p => p.name === selected) ?? null : null;
  const activeFilters = (q.trim() ? 1 : 0) + (effective !== 'all' ? 1 : 0);

  const columns: Column<NativePolicy>[] = [
    {
      key: 'policy',
      header: 'Policy',
      pin: true,
      max: '260px',
      render: p => (
        <div className="min-w-0">
          <div className="whitespace-normal font-medium [overflow-wrap:anywhere]" title={p.name}>
            {p.name}
          </div>
          <div className="mono whitespace-normal text-[12px] text-muted [overflow-wrap:anywhere]">
            {p.module ? `module ${p.module}` : p.owner ?? 'owner undeclared'}
          </div>
        </div>
      )
    },
    {
      key: 'action',
      header: 'Effect',
      render: p => (
        <span tabIndex={0} title={NATIVE_STATUS[p.effectiveStatus].hint}>
          <Pill tone={NATIVE_STATUS[p.effectiveStatus].tone}>{NATIVE_STATUS[p.effectiveStatus].label}</Pill>
        </span>
      )
    },
    {
      key: 'failure',
      header: 'On failure',
      priority: 2,
      render: p => (
        <span
          tabIndex={0}
          title={
            p.failurePolicy === 'Ignore'
              ? 'Ignore — a CEL evaluation error admits the request'
              : 'Fail — a CEL evaluation error rejects the request'
          }
        >
          <span className="mono text-[12px] text-muted">{p.failurePolicy}</span>
        </span>
      )
    },
    {
      key: 'targets',
      header: 'Targets',
      priority: 2,
      max: '220px',
      render: p => (
        // Operations above resources on purpose, and break-word so a resource name never splits mid-word.
        <span
          className="mono block whitespace-normal text-[12px] text-muted [overflow-wrap:break-word]"
          title={p.rules.map(r => `${r.group || 'core'}/${r.resource} [${r.operations.join(',')}]`).join('\n')}
        >
          <span className="block">{targetParts(p).operations}</span>
          <span className="block text-text">{targetParts(p).resources}</span>
        </span>
      )
    },
    {
      key: 'bindings',
      header: 'Bound to',
      max: '200px',
      render: p => (
        <span className={`whitespace-normal text-[12px] ${p.bindings.length === 0 && p.effectiveStatus !== 'unknown' ? 'text-warn' : 'text-muted'}`}>
          {bindingsLine(p)}
        </span>
      )
    },
    // Priority 1: the detail panel leaves this table ~645px, under `mid`'s 700px, where every priority-2
    // and -3 column sheds. Policy, Effect and Bound to fill ~560px of that, so the 104px count fits.
    { key: 'validations', header: 'Validations', ...NUMERIC, width: '104px', render: p => p.validationCount },
    {
      key: 'message',
      header: 'Rejection message',
      priority: 3,
      max: '300px',
      render: p =>
        p.messages.length === 0 ? (
          <span className="text-[12px] text-muted">no message declared</span>
        ) : (
          <span className="line-clamp-2 whitespace-normal text-[12px] text-muted" title={p.messages.join('\n\n')}>
            {p.messages[0]}
            {p.messages.length > 1 ? ` (+${p.messages.length - 1} more)` : ''}
          </span>
        )
    }
  ];

  if (loading) return <Skeleton rows={6} />;

  return (
    <div className="flex min-w-0 gap-4">
      <div className="min-w-0 flex-1 space-y-3">
        <p className="max-w-[100ch] text-[13px] text-muted">
          Kubernetes&apos; built-in ValidatingAdmissionPolicies — a second policy engine beside Gatekeeper, evaluated by
          the API server itself. A policy enforces only through a binding; one with none is declared and evaluates
          nothing. The CEL stays on the cluster; each validation&apos;s rejection message is shown instead.
        </p>

        {/* The counts, each a filter, before the rows. */}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]">
          {(Object.keys(NATIVE_STATUS) as Status[]).filter(k => k !== 'unknown' || counts.unknown > 0).map(k => (
            <button
              key={k}
              type="button"
              title={`${NATIVE_STATUS[k].hint} — show these`}
              aria-pressed={effective === k}
              onClick={() => setEffective(effective === k ? 'all' : k)}
              className={`inline-flex items-baseline gap-1.5 py-1 hover:text-accent ${effective === k ? 'text-accent' : ''}`}
            >
              <span
                className={`underline underline-offset-[3px] ${effective === k ? 'decoration-solid decoration-accent' : 'decoration-dotted decoration-line text-muted'}`}
              >
                {NATIVE_STATUS[k].label}
              </span>
              <span className={`mono ${(k === 'unbound' || k === 'no-action') && counts[k] > 0 ? 'text-warn' : 'text-text'}`}>
                <Count status={status} value={native ? counts[k] : null} />
              </span>
            </button>
          ))}
        </div>

        <FilterBar
          activeCount={activeFilters}
          onReset={() => {
            setQ('');
            setEffective('all');
          }}
          resultLine={rows.length === all.length ? `${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}` : `${rows.length} of ${all.length}`}
        >
          <SearchBox value={q} onChange={setQ} placeholder="Search policy, module, target or message" />
          <FilterSelect
            label="Effect"
            value={effective}
            onChange={e => setEffective(e as typeof effective)}
            options={[
              { value: 'all', label: 'any' },
              ...(Object.keys(NATIVE_STATUS) as Status[]).filter(k => counts[k] > 0).map(k => ({ value: k, label: NATIVE_STATUS[k].label }))
            ]}
          />
        </FilterBar>

        <DataTable
          columns={columns}
          rows={rows}
          shed="mid"
          rowKey={p => p.name}
          selectedKey={selected}
          onSelect={p => setSelected(p.name)}
          empty={
            status.state === 'unavailable' ? (
              <UnavailableEmptyBody status={status} />
            ) : activeFilters > 0 ? (
              <Empty title="No policy matches these filters" hint="This is a filter result, not an empty cluster." />
            ) : native === null ? (
              <Empty
                title="Native policy data is unavailable"
                hint="The admission policy read for this cluster did not answer, so this list could not be built. This is not a cluster with no policies."
              />
            ) : (
              <Empty
                title="No ValidatingAdmissionPolicies are defined"
                hint="The API server evaluates no built-in admission policy here; Gatekeeper and webhooks are the only gates."
              />
            )
          }
        />

        {status.state === 'ok' && native && native.orphanBindings.length > 0 && (
          <Section
            label={`Bindings to a missing policy (${native.orphanBindings.length})`}
            hint="The API server admits a binding whose policy does not exist; it enforces nothing."
          >
            <div className="divide-y divide-line text-[13px]">
              {native.orphanBindings.map(b => (
                <div key={b.name} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="mono text-text">{b.name}</span>
                  <span className="text-muted">names</span>
                  <span className="mono text-warn">{b.policyName ?? 'no policy'}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {current && <NativeDetail policy={current} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** The selected policy, in full. Inspection only. */
function NativeDetail({ policy: p, onClose }: { policy: NativePolicy; onClose: () => void }): JSX.Element {
  return (
    <DetailPanel title="ValidatingAdmissionPolicy" onClose={onClose}>
      <div className="space-y-4">
        {/* The name wraps in the body: the header truncates, and the -v1beta1 / -v1beta2 tails are the part that differs. */}
        <div className="mono text-[14px] font-medium text-text [overflow-wrap:anywhere]">{p.name}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={NATIVE_STATUS[p.effectiveStatus].tone}>{NATIVE_STATUS[p.effectiveStatus].label}</Pill>
        </div>
        <p className="text-[13px] text-muted">{NATIVE_STATUS[p.effectiveStatus].hint}</p>

        <Section label="Policy">
          <Field label="Owner" value={p.owner ?? 'undeclared'} />
          <Field label="Module" value={p.module ?? 'none declared'} mono />
          <Field label="Failure policy" value={p.failurePolicy} mono />
          <Field label="Parameters" value={p.paramKind?.kind ? `${p.paramKind.kind} (${p.paramKind.apiVersion ?? 'no apiVersion'})` : 'none'} mono />
          <Field label="Match conditions" value={p.matchConditionCount} mono />
          <Field label="Audit annotations" value={p.auditAnnotationCount} mono />
          {p.typeCheckWarningCount > 0 && (
            <Field label="Type-check warnings" value={<span className="text-warn">{p.typeCheckWarningCount}</span>} mono />
          )}
        </Section>

        <Section label={`Targets (${p.rules.length})`}>
          <div className="space-y-1">
            {p.rules.map((r, i) => (
              <div key={`${r.group}/${r.resource}/${i}`} className="mono text-[12px] text-muted">
                <span className="text-text">{r.group === '*' ? '*' : r.group || 'core'}/{r.resource}</span> [{r.operations.join(', ')}]
              </div>
            ))}
          </div>
        </Section>

        <Section label={`Bindings (${p.bindings.length})`}>
          {p.effectiveStatus === 'unknown' ? (
            <p className="text-[13px] text-muted">The binding list was not read, so which bindings select this policy is not known.</p>
          ) : p.bindings.length === 0 ? (
            <p className="text-[13px] text-warn">No binding selects this policy, so the API server never evaluates it.</p>
          ) : (
            <div className="divide-y divide-line">
              {p.bindings.map(b => (
                <div key={b.name} className="space-y-0.5 py-2 text-[13px]">
                  <div className="mono text-text">{b.name}</div>
                  <div className="text-muted">
                    {b.validationActions.length === 0 ? 'no action' : b.validationActions.join(', ')} · {bindingScopeLine(b)}
                    {b.objectSelectorPresent ? ' · narrowed by an object selector' : ''}
                    {b.paramRef ? ` · params ${b.paramRef.name ?? (b.paramRef.selectorPresent ? 'by selector' : 'unnamed')}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section label={`Rejection messages (${p.messages.length} of ${p.validationCount})`}>
          {p.messages.length === 0 ? (
            <p className="text-[13px] text-muted">No validation declares a message; the API server reports the expression instead.</p>
          ) : (
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-text">
              {p.messages.map((m, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">{m}</li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </DetailPanel>
  );
}
