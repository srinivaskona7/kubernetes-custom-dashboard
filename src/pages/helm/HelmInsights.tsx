/**
 * Insights — the first thing an operator sees after opening a release.
 *
 * ## What this tab answers
 *
 * "Is what this release installed actually working right now." Not "did Helm think it succeeded":
 * a release can sit at `deployed` with every pod in CrashLoopBackOff, because Helm's status records
 * what the last `helm upgrade` returned and nothing since. So every number on this screen is read
 * off the **live** objects — `HelmRelatedData.resources`, each carrying its own native status — and
 * the manifest is used for exactly one thing: telling us what *should* be there, so an object that
 * is missing can be named instead of silently not counted.
 *
 * ## The three states, again
 *
 * A tile whose backing read was refused shows `Unavailable`, never `0`. The tiles get that for free
 * by going through `StatTile` with a `MetricStatus` built from the page's scope — the same path the
 * rest of the console uses, so a forbidden `pods` read reads identically here and on Workloads.
 *
 * ## Read-only
 *
 * Every control is a filter or a link. There is no rollback, no restart, no scale — see the module
 * comment on `HelmReleasePage`.
 */
import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { HelmRelatedData } from '../../api';
import { Dot, Empty, Pill } from '../../components/ui';
import { Section } from '../../components/layout';
import { StatTile, type UnavailableScope } from '../../components/unavailable';
import {
  findingsFor,
  healthTiles,
  isSupersededReplicaSet,
  liveResourceHref,
  SEVERITY_TONE,
  type HelmFinding
} from './shared';

/** The severity vocabulary, stated on screen so a colour is never the only carrier. */
const SEVERITY_WHY: Record<HelmFinding['severity'], string> = {
  high: 'Broken now — an object is in a failed state, absent, or running privileged.',
  medium: 'Will bite a rollout, a drain or a renewal, but nothing is down because of it yet.',
  low: 'A standing risk with no incident attached.'
};

export function HelmInsights({
  clusterId,
  data,
  scope,
  onSelectResource,
  onGoToResources
}: {
  clusterId: string;
  data: HelmRelatedData;
  scope: UnavailableScope;
  /** Opens the page's own detail panel on one related resource. */
  onSelectResource: (id: string | null) => void;
  /** Sends the operator to the Resources tab, optionally filtered to one group. */
  onGoToResources: (group?: string) => void;
}): JSX.Element {
  const tiles = useMemo(() => healthTiles(data), [data]);
  const findings = useMemo(() => findingsFor(data), [data]);
  const byId = useMemo(() => new Map(data.resources.map(r => [r.id, r])), [data.resources]);

  /**
   * How much of the live count is rollout history rather than running workload. Derived with the same
   * predicate the Resources tab collapses on, so the two tabs cannot report different numbers.
   */
  const superseded = data.resources.filter(isSupersededReplicaSet).length;
  const missingReal = data.rendered.missing.filter(m => m.readable).length;
  const missingUnknown = data.rendered.missing.length - missingReal;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ the health grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9">
        {tiles.map(t => {
          const status = scope.of(t.label.toLowerCase(), ...t.labels);
          const countable = t.ready === null;
          return (
            <StatTile
              key={t.key}
              label={t.label}
              status={status}
              value={
                countable ? (
                  t.total
                ) : (
                  <span className="inline-flex items-baseline gap-1">
                    <Dot tone={t.tone} />
                    {t.ready}
                    <span className="text-muted">/</span>
                    {t.total}
                  </span>
                )
              }
              caption={
                countable ? (
                  t.key === 'secrets' ? (
                    <>
                      {t.word} — keys only, never values
                    </>
                  ) : (
                    <>{t.word} — this Kind reports no status</>
                  )
                ) : (
                  <>
                    {t.word}
                    {t.noStatus > 0 && ` · ${t.noStatus} report no status`}
                  </>
                )
              }
              onClick={() => onGoToResources(t.kinds[0])}
              actionLabel={`Show ${t.label.toLowerCase()} on the Resources tab`}
            />
          );
        })}
      </div>

      {/* --------------------------------------------------- rendered manifest vs the cluster */}
      <Section
        title="Rendered against live"
        hint="What the release’s manifest declares, and what the cluster actually holds."
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span className="text-muted">
            <span className="mono text-text">{data.rendered.count}</span> objects in the rendered manifest
          </span>
          <span className="text-muted">
            <span className="mono text-text">{data.counts.total}</span> live objects related to this release
          </span>
          {superseded > 0 && (
            <span
              className="text-muted"
              title="Scaled-to-zero ReplicaSets left behind by earlier rollouts. Real objects, but not running workload — the Resources tab collapses them behind a toggle."
            >
              <span className="mono text-text">{superseded}</span> of them superseded ReplicaSets
            </span>
          )}
          {missingReal > 0 && (
            <span className="text-bad">
              <span className="mono">{missingReal}</span> rendered but not present
            </span>
          )}
          {missingUnknown > 0 && (
            <span className="text-warn">
              <span className="mono">{missingUnknown}</span> could not be confirmed
            </span>
          )}
          {data.rendered.missing.length === 0 && (
            <span className="text-ok">Every rendered object was found on the cluster</span>
          )}
        </div>
        <p className="mt-2 max-w-[100ch] text-[12px] text-muted">
          The live count is larger than the rendered one on a healthy release, and that is expected: Helm renders a
          Deployment, Kubernetes creates the ReplicaSet and the Pods underneath it. Those are related to the release
          without being Helm-owned, and the Resources tab labels which is which.
        </p>
      </Section>

      {/* ---------------------------------------------------------------------------- findings */}
      <Section
        title="Findings"
        label={findings.length > 0 ? String(findings.length) : undefined}
        hint="Read off live objects, worst first. Every row names the field it came from."
      >
        {findings.length === 0 ? (
          <Empty
            title="Nothing to report"
            hint="No live object related to this release is in a failed or warning state, no rendered object is missing, and no container runs privileged or unbounded. This is a statement about the reads that succeeded — check the notice above if any did not."
          />
        ) : (
          <ul className="divide-y divide-line">
            {findings.map(f => {
              const href = f.resource ? liveResourceHref(clusterId, f.resource.kind, f.resource.namespace, f.resource.name) : null;
              const inPage = f.resource ? byId.get(`${f.resource.kind}/${f.resource.namespace ?? '-'}/${f.resource.name}`) : undefined;
              return (
                <li key={f.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 py-3 first:pt-0">
                  <span title={SEVERITY_WHY[f.severity]} className="shrink-0">
                    <Pill tone={SEVERITY_TONE[f.severity]}>{f.severity}</Pill>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-text">{f.title}</div>
                    <p className="mt-0.5 max-w-[110ch] text-[13px] text-muted">{f.detail}</p>
                    <p className="mono mt-1 text-[11px] text-muted/80" title="The field this finding was read from">
                      evidence: {f.evidence}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {inPage && (
                      <button
                        type="button"
                        onClick={() => onSelectResource(inPage.id)}
                        className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
                      >
                        Details
                      </button>
                    )}
                    {href && (
                      <Link
                        to={href}
                        className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
                        title={`Open ${f.resource!.kind} ${f.resource!.name} on the cluster page`}
                      >
                        View live resource
                      </Link>
                    )}
                    {!inPage && !href && (
                      <span className="text-[12px] text-muted/70" title="This console has no detail view for that Kind, and the object is not in this release's live set.">
                        no detail view
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {findings.length > 0 && (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-2 text-[12px] text-muted">
            {(['high', 'medium', 'low'] as const).map(s => (
              <Fragment key={s}>
                <dt className="font-medium text-text">{s}</dt>
                <dd className="max-w-[52ch]">{SEVERITY_WHY[s]}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </Section>
    </div>
  );
}
