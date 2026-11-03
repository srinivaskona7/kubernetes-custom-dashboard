/**
 * The policy drawer: one Constraint, in five views.
 *
 * Opened by `?opasel=<policy id>` — its own URL key rather than the console's `?res=`, because a
 * "policy" is a ConstraintTemplate and a Constraint together, which the single-object resource
 * registry cannot express. The consequence worth stating: a drawer link is shareable and Back
 * closes it, exactly like `?res=`.
 *
 * Every pane is read from the payload the list already has, except YAML, which fetches on open.
 * There is no Edit, no Apply, no enforcement toggle and no exemption control — the actions row is
 * navigation and inspection only.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type OpaPolicy, type OpaViolation } from '../../../api';
import { DetailPanel, Field, Section } from '../../../components/layout';
import { Btn, ErrorState, Pill, Skeleton } from '../../../components/ui';
import { ResourceLink } from '../../../components/ResourceLink';
import { SubTabs, useUrlSection } from '../../../components/SubTabs';
import { CodeViewer, valuesText } from '../../../components/CodeViewer';
import { useAsync } from '../../../useAsync';
import { ACTION_TONE, STATUS_TONE, auditLine, kindLine, linkableKind, scopeLine } from './shared';

type PaneId = 'overview' | 'constraints' | 'violations' | 'affected' | 'yaml';

const PANES = [
  { id: 'overview' as const, label: 'Overview' },
  { id: 'constraints' as const, label: 'Constraints' },
  { id: 'violations' as const, label: 'Violations' },
  { id: 'affected' as const, label: 'Affected resources' },
  { id: 'yaml' as const, label: 'YAML' }
];

/** Read and write the selected policy id. */
export function usePolicySelection(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const selected = params.get('opasel');
  const select = useCallback(
    (id: string | null) => {
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (id === null) {
            next.delete('opasel');
            // The pane key is meaningless with nothing selected, and leaving it behind would
            // reopen the next policy on whichever pane the last one was closed from.
            next.delete('opapane');
          } else {
            next.set('opasel', id);
            // Two drawers at once would fight for the same slot. Opening a policy from a violation
            // row is a deliberate move up the chain, so the violation drawer closes behind it.
            next.delete('oviolsel');
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  return [selected, select];
}

export function PolicyDrawer({
  cluster,
  policy,
  violations,
  onClose,
  onShowViolations
}: {
  cluster: string;
  policy: OpaPolicy;
  /** This policy's itemised violations, already filtered out of the payload by the caller. */
  violations: OpaViolation[];
  onClose: () => void;
  /** Jump to the Violations tab pre-filtered to this policy. */
  onShowViolations: () => void;
}): JSX.Element {
  // `keepResource` — the panes are five views of the object the drawer is already showing, so a
  // pane click must not clear the selection that put the drawer on screen.
  const [pane, setPane] = useUrlSection<PaneId>('opapane', PANES, 'overview', { keepResource: true });

  return (
    <DetailPanel
      title={policy.displayName}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone={STATUS_TONE[policy.status]}>{policy.status}</Pill>
          <Pill tone={ACTION_TONE[policy.enforcementAction]}>{policy.enforcementAction}</Pill>
          <span className="mono text-[12px] text-muted">{policy.category}</span>
        </span>
      }
      onClose={onClose}
      inlineClassName="sticky top-4 max-h-[calc(100vh-4rem)]"
    >
      <div className="flex flex-col gap-4">
        <SubTabs
          sections={PANES}
          active={pane}
          onSelect={setPane}
          counts={{ violations: policy.violationCount, affected: violations.length }}
        />

        {pane === 'overview' && <OverviewPane policy={policy} onShowViolations={onShowViolations} />}
        {pane === 'constraints' && <ConstraintsPane policy={policy} />}
        {pane === 'violations' && <ViolationsPane policy={policy} violations={violations} />}
        {pane === 'affected' && <AffectedPane violations={violations} />}
        {pane === 'yaml' && <YamlPane cluster={cluster} policy={policy} />}
      </div>
    </DetailPanel>
  );
}

function OverviewPane({ policy, onShowViolations }: { policy: OpaPolicy; onShowViolations: () => void }): JSX.Element {
  return (
    <div className="space-y-4">
      {/*
        The purpose sentence, and where it came from. The provenance is shown rather than hidden
        because the four sources are not equally trustworthy: an annotation is the policy author
        speaking, while `identity` is this console saying only what the names already say. An
        operator deciding whether to act on a policy needs to know which one they are reading.
      */}
      <div className="rounded-[8px] border border-line bg-surface p-4">
        <p className="text-[14px] leading-snug text-text">{policy.purpose.text}</p>
        <p className="mt-1.5 text-[12px] text-muted">
          {policy.purpose.source === 'annotation'
            ? 'From this Constraint’s description annotation'
            : policy.purpose.source === 'template-annotation'
              ? 'From the ConstraintTemplate’s description annotation'
              : policy.purpose.source === 'mapping'
                ? 'From this console’s maintained description for this upstream template'
                : 'No description is published for this policy — this states only what its template and target kinds are'}
        </p>
      </div>

      {policy.ineffectiveReasons.length > 0 && (
        <Section label="Declared, but enforces nothing">
          {/*
            The exact detected reason, one per row, never "possibly ineffective". Each of these is
            a specific observed fact — a dry-run action, an empty namespace match, a template the
            controller rejected — and an operator can only fix the one that is actually true.
          */}
          <ul className="space-y-1.5">
            {policy.ineffectiveReasons.map(r => (
              <li key={r.code} className="flex items-start gap-2 text-[13px]">
                <span className="mono mt-[1px] shrink-0 rounded-[4px] border border-line bg-raised px-1.5 text-[11px] text-warn">
                  {r.code}
                </span>
                <span className="text-muted">{r.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label="Scope">
        <Field label="Target kinds" value={kindLine(policy)} mono />
        <Field label="Namespaces" value={scopeLine(policy)} />
        <Field label="Enforcement action" value={policy.enforcementAction} mono />
        <Field label="Category" value={`${policy.category}${policy.categorySource === 'fallback' ? ' (uncategorised)' : ''}`} />
      </Section>

      <Section label="Evidence">
        <Field
          label="Audit violations"
          value={
            policy.violationCount === null ? (
              <span className="text-muted">not reported yet — unread, not zero</span>
            ) : (
              <span>
                {policy.violationCount}
                {policy.violationsTruncated && (
                  <span className="ml-1.5 text-[12px] text-muted">
                    ({policy.violationsShown} itemised — Gatekeeper caps the list)
                  </span>
                )}
              </span>
            )
          }
        />
        <Field label="Last audit" value={auditLine(policy)} />
      </Section>

      <div className="flex flex-wrap gap-2">
        <Btn onClick={onShowViolations} disabled={(policy.violationCount ?? 0) === 0}>
          View violations
        </Btn>
      </div>
    </div>
  );
}

function ConstraintsPane({ policy }: { policy: OpaPolicy }): JSX.Element {
  return (
    <div className="space-y-4">
      <Section label="Identity">
        <Field label="ConstraintTemplate" value={policy.templateName} mono />
        <Field label="Constraint kind" value={policy.constraintKind ?? 'not defined'} mono />
        <Field
          label="Constraint"
          value={policy.constraintName ?? 'no instance exists — the template defines a rule nothing applies'}
          mono
        />
      </Section>

      <Section label="Match">
        {policy.targetKinds.length === 0 ? (
          <p className="text-[13px] text-muted">No kinds are configured, so nothing matches this policy.</p>
        ) : (
          policy.targetKinds.map((t, i) => (
            <Field
              key={i}
              label={`Group ${t.apiGroups.map(g => g || '(core)').join(', ') || '(any)'}`}
              value={t.kinds.join(', ') || '(any kind)'}
              mono
            />
          ))
        )}
        {policy.namespaceScope.included && (
          <Field label="Namespaces included" value={policy.namespaceScope.included.join(', ')} mono />
        )}
        {policy.namespaceScope.excluded && (
          <Field label="Namespaces excluded" value={policy.namespaceScope.excluded.join(', ')} mono />
        )}
      </Section>

      {/*
        Parameters as JSON rather than a rendered form: they are template-defined and arbitrary,
        so any field-by-field rendering would either invent structure or drop keys. Read-only.
      */}
      {policy.parameters !== null && policy.parameters !== undefined && (
        <Section label="Parameters">
          <CodeViewer
            label="CONSTRAINT PARAMETERS"
            text={valuesText(policy.parameters)}
            language="json"
            searchable={false}
            maxHeight="280px"
          />
        </Section>
      )}

      {policy.enforcedByPods.length > 0 && (
        <Section label="Enforced by">
          {/*
            Gatekeeper's own per-pod acknowledgement. A pod listed with `enforced: false` has not
            yet ingested this Constraint, which means requests reaching that replica are not
            evaluated against it — invisible in every other view.
          */}
          {policy.enforcedByPods.map(p => (
            <Field
              key={p.pod}
              label={p.pod}
              value={p.enforced ? 'enforcing' : 'not enforcing this constraint yet'}
              mono
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function ViolationsPane({ policy, violations }: { policy: OpaPolicy; violations: OpaViolation[] }): JSX.Element {
  if (policy.violationCount === null) {
    return (
      <p className="px-1 py-6 text-[13px] text-muted">
        Gatekeeper has not published a violation count for this policy, so this is unread rather than zero. It
        appears once the audit controller has evaluated the Constraint at least once.
      </p>
    );
  }
  if (violations.length === 0) {
    return (
      <p className="px-1 py-6 text-[13px] text-muted">
        The last audit found no object violating this policy.{' '}
        {policy.audit.state === 'stale' && 'That audit is stale, so this may be out of date.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {policy.violationsTruncated && (
        <p className="text-[12px] text-warn">
          Showing {policy.violationsShown} of {policy.violationCount}. Gatekeeper itself caps the itemised list at
          its audit pod’s <span className="mono">--constraint-violations-limit</span>; the total above is complete.
        </p>
      )}
      <ul className="divide-y divide-line">
        {violations.map(v => (
          <li key={v.id} className="py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <ViolationSubject violation={v} />
              <span className="mono text-[12px] text-muted">
                {v.kind}
                {v.namespace ? ` · ${v.namespace}` : ' · cluster-scoped'}
              </span>
            </div>
            {/* Gatekeeper's own message, verbatim. Rewording it would change what the policy said. */}
            <p className="mt-0.5 text-[13px] text-muted">{v.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AffectedPane({ violations }: { violations: OpaViolation[] }): JSX.Element {
  // The distinct objects, because one object can violate the same policy through several messages
  // and counting it twice would overstate the blast radius.
  const objects = useMemo(() => {
    const seen = new Map<string, OpaViolation>();
    for (const v of violations) {
      const key = `${v.kind}/${v.namespace ?? '-'}/${v.name}`;
      if (!seen.has(key)) seen.set(key, v);
    }
    return [...seen.values()];
  }, [violations]);

  if (objects.length === 0) {
    return (
      <p className="px-1 py-6 text-[13px] text-muted">
        No object is currently recorded as affected by this policy. This lists the objects from the last audit — it
        is not a list of every resource the policy would evaluate, which Gatekeeper does not publish.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted">
        Objects the last audit found in violation. Not a list of everything this policy evaluates — Gatekeeper does
        not report that, so a coverage denominator is not available.
      </p>
      <ul className="divide-y divide-line">
        {objects.map(v => (
          <li key={`${v.kind}/${v.namespace ?? '-'}/${v.name}`} className="flex flex-wrap items-baseline gap-2 py-2">
            <ViolationSubject violation={v} />
            <span className="mono text-[12px] text-muted">
              {v.kind} · {v.namespace ?? 'cluster-scoped'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function YamlPane({ cluster, policy }: { cluster: string; policy: OpaPolicy }): JSX.Element {
  // Fetched here, in the pane, so opening a drawer costs nothing until the operator asks for YAML.
  const manifest = useAsync(
    useCallback(
      () => api.clusterOpaPolicyYaml(cluster, policy.templateName, policy.constraintName),
      [cluster, policy.templateName, policy.constraintName]
    ),
    0,
    `${cluster}:${policy.id}`
  );

  if (manifest.initial) return <Skeleton rows={8} />;
  if (manifest.error && !manifest.data) {
    return <ErrorState code={manifest.error.code} message={manifest.error.message} />;
  }
  if (manifest.data && !manifest.data.ok) {
    return (
      <ErrorState
        cluster={cluster}
        code={manifest.data.error?.code ?? 'UNKNOWN'}
        message={manifest.data.error?.message ?? 'the manifest could not be read'}
        needsReseed={manifest.data.error?.needsReseed}
      />
    );
  }

  const documents = manifest.data?.ok ? manifest.data.data?.documents ?? [] : [];
  return (
    <div className="space-y-4">
      {documents.map(doc => (
        <div key={`${doc.kind}/${doc.name}`}>
          {/*
            The label states which live object this is, verbatim from the server. It matters
            because the console shows Helm's rendered manifests elsewhere, and an operator
            debugging the wrong copy of an object is a whole afternoon.
          */}
          <CodeViewer
            label={doc.label}
            meta={`${doc.kind}/${doc.name}`}
            text={doc.yaml}
            language="yaml"
            maxHeight="420px"
          />
        </div>
      ))}
      {documents.length === 0 && <p className="text-[13px] text-muted">The server returned no manifest for this policy.</p>}
    </div>
  );
}

/**
 * The violating object's name — a link when the console has a drawer for its Kind, plain text
 * otherwise. Same rule as the Violations table, in one place so the two cannot diverge.
 */
function ViolationSubject({ violation }: { violation: OpaViolation }): JSX.Element {
  const kind = linkableKind(violation.kind);
  if (!kind) return <span className="font-medium">{violation.name}</span>;
  return <ResourceLink refTo={{ kind, namespace: violation.namespace, name: violation.name }} />;
}
