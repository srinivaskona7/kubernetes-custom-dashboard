import { describe, expect, it } from 'vitest';
import { mergeElevated, namesAreReported } from './elevated-containers';

const ref = (namespace: string, pod: string, container: string) => ({ namespace, pod, container });

describe('mergeElevated', () => {
  it('names a container once when both lists flag it', () => {
    const rows = mergeElevated([ref('app', 'web-1', 'nginx')], [ref('app', 'web-1', 'nginx')]);

    expect(rows).toEqual([
      { namespace: 'app', pod: 'web-1', container: 'nginx', privileged: true, rootCapable: true }
    ]);
  });

  it('keeps two containers in the same pod apart', () => {
    const rows = mergeElevated(undefined, [ref('app', 'web-1', 'nginx'), ref('app', 'web-1', 'sidecar')]);

    expect(rows.map(r => r.container)).toEqual(['nginx', 'sidecar']);
    expect(rows.every(r => r.rootCapable && !r.privileged)).toBe(true);
  });

  it('puts privileged containers above root-capable ones, whatever the input order', () => {
    const rows = mergeElevated(
      [ref('zzz', 'z-pod', 'z-container')],
      [ref('aaa', 'a-pod', 'a-container'), ref('bbb', 'b-pod', 'b-container')]
    );

    expect(rows.map(r => r.namespace)).toEqual(['zzz', 'aaa', 'bbb']);
  });

  it('sorts stably within a tier, so a poll does not reshuffle the table', () => {
    const forwards = mergeElevated(undefined, [
      ref('b', 'p2', 'c1'),
      ref('a', 'p9', 'c1'),
      ref('a', 'p1', 'c2'),
      ref('a', 'p1', 'c1')
    ]);
    const backwards = mergeElevated(undefined, [
      ref('a', 'p1', 'c1'),
      ref('a', 'p1', 'c2'),
      ref('a', 'p9', 'c1'),
      ref('b', 'p2', 'c1')
    ]);

    const key = (r: { namespace: string; pod: string; container: string }) =>
      `${r.namespace}/${r.pod}/${r.container}`;
    expect(forwards.map(key)).toEqual(['a/p1/c1', 'a/p1/c2', 'a/p9/c1', 'b/p2/c1']);
    expect(backwards.map(key)).toEqual(forwards.map(key));
  });

  it('carries no field beyond the three names and the two findings', () => {
    const [row] = mergeElevated([ref('app', 'web-1', 'nginx')], undefined);

    expect(Object.keys(row!).sort()).toEqual(['container', 'namespace', 'pod', 'privileged', 'rootCapable']);
  });

  it('is empty when the server sent no lists — the caller decides what that means', () => {
    expect(mergeElevated(undefined, undefined)).toEqual([]);
  });
});

describe('namesAreReported', () => {
  // Absent is not empty. An older server says nothing about which containers were flagged; `[]` is
  // the real answer "none were", and only the second one may be drawn as a clean audit.
  it('is false when the server reported neither list', () => {
    expect(namesAreReported({})).toBe(false);
  });

  it('is true for an empty list, because that is an answer', () => {
    expect(namesAreReported({ privilegedContainerList: [] })).toBe(true);
    expect(namesAreReported({ rootCapableContainerList: [] })).toBe(true);
  });
});
