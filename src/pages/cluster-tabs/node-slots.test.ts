import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeConditionsEmpty, slotAccounting, slotExclusionNote } from './node-slots';

const node = (over: Partial<Parameters<typeof slotAccounting>[0][number]> = {}) => ({
  name: 'n1',
  pods: 10,
  podCapacity: 110,
  ready: true,
  unschedulable: false,
  ...over
});

describe('slotAccounting', () => {
  it('excludes NotReady and cordoned nodes from both numerator and denominator', () => {
    const a = slotAccounting([
      node({ name: 'ok' }),
      node({ name: 'down', ready: false }),
      node({ name: 'cordoned', unschedulable: true })
    ]);
    expect(a.capacity).toBe(110);
    expect(a.used).toBe(10);
    expect(a.countedNodes).toBe(1);
    expect(a.excludedNotReady).toBe(1);
    expect(a.excludedCordoned).toBe(1);
  });

  /*
    This replaces a test that read

      const cardCount = nodes.filter(n => n.ready && !n.unschedulable).length;
      expect(slotAccounting(nodes).countedNodes).toBe(cardCount);

    Both sides were the same predicate, one of them re-typed in the test, so it could not observe
    the card at all: editing ClusterDetail.tsx's own filter left it green. The invariant is not
    "these two numbers agree on my fixture" — it is "there is only one spelling of the predicate",
    so the assertion has to be about the source.
  */
  it('is the only place the readiness/cordon predicate is spelled out', () => {
    const src = readFileSync(new URL('../ClusterDetail.tsx', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    expect(code).toContain('isSchedulable');
    expect(/\.ready\s*&&\s*!\s*\w+\.unschedulable/.test(code)).toBe(false);
  });

  it('never reports a negative free count when capacity and pods disagree', () => {
    // A kubelet reporting `pods: "0"` while pods run on it, or a count read a moment apart from
    // the capacity read. "-12 free" is a contradiction, not a measurement.
    const a = slotAccounting([node({ podCapacity: 0, pods: 12 })]);
    expect(a.capacity).toBe(0);
    expect(a.free).toBe(0);
    expect(a.pct).toBeNull();
    expect(a.used).toBe(12);
  });

  it('keeps a node that reported no pod capacity out of both sides', () => {
    const a = slotAccounting([node({ name: 'a' }), node({ name: 'b', podCapacity: null, pods: 40 })]);
    expect(a.capacity).toBe(110);
    expect(a.used).toBe(10);
    expect(a.excludedNoCapacity).toBe(1);
  });

  it('reports null capacity, not 0, when nobody schedulable reported one', () => {
    const a = slotAccounting([node({ podCapacity: null })]);
    expect(a.capacity).toBeNull();
    expect(a.pct).toBeNull();
    expect(a.free).toBeNull();
  });

  it('names every excluded node in the note, and says nothing when there are none', () => {
    expect(slotExclusionNote(slotAccounting([node()]))).toBeNull();
    const note = slotExclusionNote(
      slotAccounting([node(), node({ ready: false }), node({ unschedulable: true }), node({ podCapacity: null })])
    );
    expect(note).toBe('3 nodes not counted here: 1 NotReady, 1 cordoned, 1 reporting no pod capacity.');
  });
});

describe('nodeConditionsEmpty', () => {
  /*
    This assertion is INVERTED from the one it replaces, and the inversion is the point.

    It used to read `expect(e.hint).not.toContain('NotReady')`, because health.js filtered `Ready`
    out of `problems` and an all-clear mentioning NotReady would have claimed a condition nobody
    read. `isProblemCondition` is now the single node-problem predicate with
    `HEALTHY_WHEN_TRUE = {Ready, SystemdUnitsReady}`, and `nodeProblems` runs EVERY condition through
    it — so an empty `problems` list does now cover readiness, and refusing to say so would
    under-report a real all-clear. The claim follows the predicate; when the predicate moved, so did
    the sentence and so does this test.
  */
  it('claims readiness too, because the predicate now covers it', () => {
    const e = nodeConditionsEmpty([{ ready: true, unschedulable: false }]);
    expect(e.hint).toContain('NotReady');
    expect(e.hint).toContain('MemoryPressure, DiskPressure or PIDPressure');
    expect(e.hint).toContain('part of the same predicate');
  });

  it('reports a NotReady node as a contradiction, not as an all-clear beside its red pill', () => {
    const e = nodeConditionsEmpty([{ ready: false, unschedulable: false }, { ready: true, unschedulable: false }]);
    expect(e.title).toBe('1 node is NotReady');
    expect(e.hint).toContain('one node reads NotReady');
    // Readiness is inside the predicate now, so an empty problems list AND a NotReady node cannot
    // both be true. Saying the two reads disagree is more useful than printing either alone.
    expect(e.hint).toContain('disagree');
    expect(e.title).not.toContain('No node conditions');
  });

  it('pluralises the NotReady count', () => {
    const e = nodeConditionsEmpty([{ ready: false, unschedulable: false }, { ready: false, unschedulable: true }]);
    expect(e.title).toBe('2 nodes are NotReady');
    expect(e.hint).toContain('2 nodes read NotReady');
  });
});
