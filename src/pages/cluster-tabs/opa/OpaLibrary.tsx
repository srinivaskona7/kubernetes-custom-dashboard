/**
 * Policy library & Pod Security bundles — the Overview section that says where this cluster's
 * policies came from.
 *
 * Two questions a list of ConstraintTemplates cannot answer by itself: "is this an upstream
 * gatekeeper-library policy or something written here" and "how much of the library's Pod Security
 * baseline and restricted bundles is in force". Both are joins the server makes against a pinned
 * catalogue; this component only renders them. Props only — the payload is the shell's.
 *
 * Coverage is by library template name. Pod Security Admission namespace labels and Kyma's own
 * ValidatingAdmissionPolicies can enforce the same controls without any of these templates, so
 * "0 of 12" says the Gatekeeper bundle is absent — not that pods are unguarded — and the hint says so.
 */
import type { OpaData } from '../../../api';
import type { MetricStatus } from '../../../components/unavailable';
import { Count } from '../../../components/unavailable';
import { Section } from '../../../components/layout';
import { useFindingNavigation } from '../../../findings';
import { bundleName, listHead, missingTemplates } from './library';

export function LibrarySection({ data, status }: { data: OpaData; status: MetricStatus }): JSX.Element {
  const go = useFindingNavigation();
  const lib = data.summary.library;
  const src = data.library.source;
  const pinned = src?.commit ? `gatekeeper-library ${src.commit.slice(0, 7)}${src.date ? ` (${src.date})` : ''}` : 'gatekeeper-library';

  return (
    <Section
      label="Policy library & Pod Security bundles"
      hint={`Templates matched by name and Rego against ${pinned}. Bundle coverage counts Gatekeeper templates only — Pod Security Admission labels and native admission policies are not counted here.`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]">
          {(
            [
              ['library', 'from the library', 'library templates, Rego unchanged'],
              ['modified', 'modified', 'library names whose Rego differs'],
              ['custom', 'custom', 'templates not in the library'],
              ['behind', 'behind the library', 'templates annotated with an older version than the library']
            ] as const
          ).map(([key, label, hint]) => (
            <button
              key={key}
              type="button"
              title={`${hint} — show the policies`}
              onClick={() => go({ params: { opa: 'policies', oorigin: key } })}
              className="inline-flex items-baseline gap-1.5 text-left hover:text-accent"
            >
              <span className="text-muted">{label}</span>
              <span className={key === 'modified' || key === 'behind' ? (lib[key] > 0 ? 'text-warn' : 'text-text') : 'text-text'}>
                <Count status={status} value={lib[key]} />
              </span>
            </button>
          ))}
        </div>

        {data.library.bundles.length === 0 ? (
          <p className="text-[13px] text-muted">
            {data.summary.templateLimitExceeded
              ? `Bundle coverage not evaluated — over ${data.summary.templateLimit} templates the Constraint lists are not read, so which templates deny is not known.`
              : 'Bundle coverage not evaluated — the ConstraintTemplate list was not read, so a count here would be a guess.'}
          </p>
        ) : (
          // Two rows with no header, so a list and not a table: grouped with dividers.
          <div className="divide-y divide-line text-[13px]">
            {data.library.bundles.map(b => {
              const missing = missingTemplates(b);
              return (
                <div key={b.bundle} className="grid grid-cols-[190px_130px_130px_minmax(0,1fr)] items-baseline gap-x-4 py-2">
                  <span className="text-text">{bundleName(b.bundle)}</span>
                  <span className="text-muted">
                    <span className="mono text-text">{b.installed}</span> of {b.total} present
                  </span>
                  <span
                    className="text-muted"
                    title={b.enforcingUnknown > 0 ? `${b.enforcingUnknown} installed template${b.enforcingUnknown === 1 ? '' : 's'} could not be read, so this is a floor` : undefined}
                  >
                    <span className={`mono ${b.enforcing === b.total ? 'text-ok' : 'text-text'}`}>
                      {b.enforcingUnknown > 0 ? '≥' : ''}
                      {b.enforcing}
                    </span>{' '}
                    of {b.total} deny
                  </span>
                  <span className="text-[12px] text-muted" title={missing.length > 6 ? missing.join(', ') : undefined}>
                    {missing.length === 0 ? 'every template present' : `absent: ${listHead(missing, 6)}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Section>
  );
}
