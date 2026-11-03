/**
 * One stored Helm revision: fetching it, and comparing two of them.
 *
 * Shared by Values, Manifest and History because all three read the same per-revision record and
 * must agree about it — what "the deployed revision" means, what the redaction sentence says, and
 * what counts as a change between two revisions. Three copies of that is three chances for the
 * History tab to report four changed values while the Values tab shows five.
 */
import { useCallback, type ReactNode } from 'react';
import { api, type HelmManifestData, type HelmRelease } from '../../api';
import { CapabilityNotice } from '../../capability';
import type { ValueDelta } from '../../components/code-compare';
import { Empty, ErrorBanner, Skeleton } from '../../components/ui';
import { useAsync } from '../../useAsync';

/** Printed under every values and manifest pane. The reason is in `HelmValues`'s module comment. */
export const REDACTION_NOTE =
  'Values under credential-shaped keys read [redacted], by key name and by structure — a nested auth.password is masked even though auth is not. The key and the fact it is set are shown; the value never leaves the cluster.';

/** Every leaf of a values tree as `a.b.c` → rendered value. The unit a change is counted in. */
function flattenValues(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (value === null || typeof value !== 'object') {
    if (prefix) out.set(prefix, JSON.stringify(value ?? null));
    return out;
  }
  if (Array.isArray(value)) {
    // Arrays are compared whole. Index-wise comparison reports a one-element insertion as every
    // later element having changed, which is noise dressed as information.
    out.set(prefix || '.', JSON.stringify(value));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    for (const [path, leaf] of flattenValues(v, prefix ? `${prefix}.${k}` : k)) out.set(path, leaf);
  }
  return out;
}

/**
 * What changed between two value trees, by path.
 *
 * Leaf paths rather than lines, so `image.tag` changing once counts as one change instead of the
 * three lines of YAML around it. Both sides are already masked, which means a rotated credential
 * reads as unchanged — the panes that use this say so, because silently reporting "no changes" over
 * a rotation would be the wrong kind of reassuring.
 */
export function diffValues(before: unknown, after: unknown): ValueDelta {
  const a = flattenValues(before);
  const b = flattenValues(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, val] of b) {
    if (!a.has(path)) added.push(path);
    else if (a.get(path) !== val) changed.push(path);
  }
  for (const path of a.keys()) if (!b.has(path)) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Fetches one stored revision's record and hands it to its children.
 *
 * Mounted only by the panes that need it, which is what makes §7's "only the mounted pane fetches"
 * a structural property rather than a condition someone has to remember to update. A failed
 * *refresh* keeps the last good payload on screen under a banner; a failed first load does not
 * pretend to have one.
 */
export function WithRevision({
  clusterId,
  release,
  revision,
  children
}: {
  clusterId: string;
  release: HelmRelease;
  /** Omit for the deployed revision. */
  revision?: number;
  children: (payload: HelmManifestData) => ReactNode;
}): JSX.Element {
  const ns = release.namespace ?? '';
  const { data, error, initial } = useAsync(
    useCallback(
      () => api.clusterHelmManifest(clusterId, ns, release.name, revision),
      [clusterId, ns, release.name, revision]
    ),
    0,
    `${clusterId}/${ns}/${release.name}/${revision ?? 'deployed'}`
  );

  if (initial) return <Skeleton rows={6} />;
  if (!data) return <ErrorBanner code={error!.code} message={error!.message} />;
  // `ok` and `data` are independent fields on the envelope, not a discriminated union, so an `ok`
  // response with no payload is representable and has to be handled rather than asserted away.
  const payload = data.ok ? data.data : undefined;
  if (!payload) {
    return data.error ? (
      <ErrorBanner code={data.error.code} message={data.error.message} />
    ) : (
      <Empty title="That revision could not be read" />
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-[8px] border border-warn/40 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
          <strong className="font-semibold">This did not refresh.</strong> {error.message} What follows is the last
          reading that succeeded.
        </div>
      )}
      <CapabilityNotice capability={payload.capability} />
      {children(payload)}
    </div>
  );
}
