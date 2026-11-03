/**
 * The two container-posture lists, merged into the rows the Security tab draws.
 *
 * Its own module for the reason every sibling here is (`node-pods.ts`, `log-pods.ts`): the logic is
 * pure, it is the part that can be wrong in a way a screenshot does not show, and a `.ts` file is
 * what `vitest` can import without a DOM.
 *
 * The merge exists because the two lists overlap. `privileged: true` implies root capability, so
 * `srv/fleet/collectors/security.js` can name the same container in both — it walks the pods once
 * and appends to whichever list applies. Rendering them as two tables would print that container
 * twice under two headings and inflate what an operator reads as the size of the problem.
 */
import type { ContainerRef } from '../../api';

/** One flagged container, and every reason it was flagged. */
export interface ElevatedContainer extends ContainerRef {
  privileged: boolean;
  rootCapable: boolean;
}

/**
 * One row per container, privileged first.
 *
 * Identity is `namespace/pod/container`, which is the only key a container has — it is a ref on its
 * pod rather than an object with a UID of its own. Ties break alphabetically so the order is stable
 * between polls; an operator reading a table that reshuffles every 30 s loses their place in it.
 */
export function mergeElevated(
  privileged: readonly ContainerRef[] | undefined,
  rootCapable: readonly ContainerRef[] | undefined
): ElevatedContainer[] {
  const byId = new Map<string, ElevatedContainer>();
  const mark = (ref: ContainerRef, finding: 'privileged' | 'rootCapable') => {
    const key = `${ref.namespace}/${ref.pod}/${ref.container}`;
    const row = byId.get(key) ?? {
      namespace: ref.namespace,
      pod: ref.pod,
      container: ref.container,
      privileged: false,
      rootCapable: false
    };
    row[finding] = true;
    byId.set(key, row);
  };
  for (const ref of privileged ?? []) mark(ref, 'privileged');
  for (const ref of rootCapable ?? []) mark(ref, 'rootCapable');

  return [...byId.values()].sort((a, b) => {
    if (a.privileged !== b.privileged) return a.privileged ? -1 : 1;
    return (
      a.namespace.localeCompare(b.namespace) ||
      a.pod.localeCompare(b.pod) ||
      a.container.localeCompare(b.container)
    );
  });
}

/**
 * Did this server report the lists at all?
 *
 * Absent is not empty. A server older than the two fields says nothing about which containers were
 * flagged, while `[]` is the real answer "none were" — and a table headed "Containers with elevated
 * privileges" rendering empty for the first reason would read as a clean audit that never happened.
 */
export function namesAreReported(payload: {
  privilegedContainerList?: readonly ContainerRef[];
  rootCapableContainerList?: readonly ContainerRef[];
}): boolean {
  return payload.privilegedContainerList !== undefined || payload.rootCapableContainerList !== undefined;
}
