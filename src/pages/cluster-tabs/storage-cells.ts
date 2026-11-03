/**
 * The four "absent is not zero" rules the Storage tab renders, kept out of JSX so they can be
 * unit-tested (this project's vitest runs `environment: 'node'`, so nothing that renders can be).
 *
 * Every one of them exists because the collector used to substitute a plausible value for a fact
 * it did not have: a PVC's bound capacity fell back to its request, an absent `storageClassName`
 * was published as the literal `'default'`, an unreconciled quota dimension read `0`, and a
 * dimension the quota never mentions read `unlimited`. The collector now sends `null` in all four
 * cases; these functions are the vocabulary that puts each on screen as the state it is.
 */

/** What an absent value is allowed to look like on the wire. */
type Maybe = string | null | undefined;

/** The em-dash-plus-reason form used wherever a number is genuinely not reported. */
export const NOT_REPORTED = '— not reported';

/**
 * A PVC's bound capacity. `null` until the volume is bound and the provisioner has said how much
 * it actually provided — which can be more than was asked for. Never the request: echoing the ask
 * back would make an unreported capacity indistinguishable from one honoured exactly.
 */
export function capacityLabel(capacity: Maybe): string {
  return capacity == null || capacity === '' ? NOT_REPORTED : capacity;
}

/**
 * A PVC's StorageClass.
 *
 * Three states, and the middle one is the reason this function exists: a claim that names no class
 * is *not* a claim on a class called `default`. Some clusters really do ship a StorageClass named
 * `default`, so the old literal was ambiguous as well as wrong.
 */
export function storageClassLabel(storageClass: Maybe): string {
  if (storageClass == null) return 'none set (cluster default applies)';
  if (storageClass === '') return 'explicitly empty (no dynamic provisioning)';
  return storageClass;
}

/** True when the cell above is a statement about the claim rather than a class name. */
export function storageClassIsAbsent(storageClass: Maybe): boolean {
  return storageClass == null || storageClass === '';
}

/**
 * One quota dimension as `used / hard`, with each half able to be absent on its own.
 *
 *  - `used` absent: the quota controller has not reported usage for this dimension. `0` there
 *    claims a completely idle namespace, which is a verdict we do not have.
 *  - `hard` absent: this quota does not mention the resource at all. `unlimited` there claims an
 *    enforced absence of a limit — other quotas in the namespace may well cap it.
 */
export function quotaDimensionLabel(used: Maybe, hard: Maybe): string {
  const left = used == null ? 'not reported' : used;
  const right = hard == null ? 'not in this quota' : hard;
  return `${left} / ${right}`;
}

/**
 * Whether a quota's numbers are being enforced or are only configured.
 *
 * `spec.hard` is the author's ask; `status.hard` is what the controller accepted. A quota that has
 * the first and not the second is enforcing nothing, and the tab has to say so rather than drawing
 * the intended ceiling as a live one.
 */
export function quotaSourceNote(hardSource: string | null | undefined): string | null {
  if (hardSource === 'enforced') return null;
  if (hardSource === 'configured') return 'configured, not yet enforced by the quota controller';
  return 'no limits read — neither status nor spec declares any';
}

/** The tone for that note. Absent enforcement is a caveat, not a failure. */
export function quotaSourceTone(hardSource: string | null | undefined): 'ok' | 'warn' | 'unknown' {
  if (hardSource === 'enforced') return 'ok';
  if (hardSource === 'configured') return 'warn';
  return 'unknown';
}

/**
 * The sort key for the Bound capacity column: the bytes the collector parsed, never the `5Gi`
 * string, which sorts `512Mi` above `5Gi` as text. Absent stays `null` so the table keeps it out
 * of the ordering instead of ranking it as a zero-byte volume.
 *
 * `api.ts`'s `PvcRow` does not declare `capacityBytes` yet (see the handoff), so the parameter is
 * typed structurally and optional — the wire has carried the field since `storage.js` began
 * publishing it beside `capacity`.
 */
export function pvcCapacityBytes(p: { capacity?: Maybe; capacityBytes?: number | null }): number | null {
  return p.capacityBytes ?? null;
}

/** Search text for a PVC row, tolerant of the two fields that are now nullable. */
export function pvcSearchText(p: { name: string; namespace: string; storageClass: Maybe }): string {
  return [p.name, p.namespace, storageClassLabel(p.storageClass)].join(' ').toLowerCase();
}

/**
 * The quota shape as `storage.js` actually sends it.
 *
 * `api.ts`'s `QuotaRow` still declares `hard`/`used` as plain strings and carries no `hardSource`,
 * which is a stale contract now that the collector distinguishes absent from zero — updating it is
 * a separate file's change (see the handoff). This is the wire truth, applied at the one place the
 * tab reads those fields, so no cell is typed as a string it can no longer rely on.
 */
export interface QuotaWire {
  hardSource: string | null;
  usedReported: boolean;
  dimensions: { dimension: string; hard: string | null; used: string | null }[];
}

export function quotaWireOf(q: unknown): QuotaWire {
  return q as QuotaWire;
}
