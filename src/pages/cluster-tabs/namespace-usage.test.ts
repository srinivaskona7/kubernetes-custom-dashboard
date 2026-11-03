import { describe, expect, it } from 'vitest';
import {
  coverageNote,
  figuresText,
  mergeNamespaceUsage,
  meterGeometry,
  pctOf,
  ofRequestText,
  podsLabel,
  restartsText,
  usageVerdict,
  type NamespaceUsage
} from './namespace-usage';
import type { NamespaceRow } from '../../api';
import type { UtilizationNamespace } from './usage/utilization-model';

const nsRow = (namespace: string, pods: number | null, system = false): NamespaceRow =>
  ({ namespace, pods, system, verdict: 'compliant', findings: 0, checks: [] }) as unknown as NamespaceRow;

const util = (namespace: string, over: Partial<UtilizationNamespace> = {}): UtilizationNamespace =>
  ({
    namespace,
    pods: 2,
    cpuUsage: 0.5,
    cpuRequest: 1,
    cpuLimit: 2,
    memoryUsage: 100,
    memoryRequest: 200,
    memoryLimit: 400,
    usageMissing: 0,
    counted: 2,
    noCpuRequest: 0,
    noMemoryRequest: 0,
    noCpuLimit: 0,
    noMemoryLimit: 0,
    cpuShare: null,
    memoryShare: null,
    cpuOfRequest: null,
    memoryOfRequest: null,
    memoryOfLimit: null,
    restarts: 0,
    oomKilled: 0,
    nearMemoryLimit: 0,
    ...over
  }) as unknown as UtilizationNamespace;

describe('mergeNamespaceUsage', () => {
  it('keeps every namespace from the inventory, including ones the workloads read never saw', () => {
    const out = mergeNamespaceUsage([nsRow('a', 3), nsRow('jobs-only', 4)], [util('a')]);
    expect(out.map(n => n.namespace)).toEqual(['a', 'jobs-only']);
    const jobs = out[1]!;
    expect(jobs.measured).toBe(false);
    expect(jobs.pods).toBe(4);
    expect(jobs.cpu).toEqual({ used: null, request: null, limit: null, limitPartial: false });
  });

  it('never invents a namespace the inventory did not list', () => {
    const out = mergeNamespaceUsage([nsRow('a', 1)], [util('a'), util('ghost')]);
    expect(out.map(n => n.namespace)).toEqual(['a']);
  });

  it('marks a limit as partial when some counted pods declared none', () => {
    const rows = [{ namespace: 'a', system: false, pods: 2 }] as unknown as NamespaceRow[];
    const util = [{ namespace: 'a', pods: 2, memoryLimit: 256, noMemoryLimit: 1, cpuLimit: 1, noCpuLimit: 0 }] as unknown as UtilizationNamespace[];
    const [out] = mergeNamespaceUsage(rows, util);
    expect(out!.memory.limitPartial).toBe(true);
    expect(out!.cpu.limitPartial).toBe(false);
  });

  it('reads a summed request or limit of zero as none declared, not as a budget of zero', () => {
    const out = mergeNamespaceUsage([nsRow('a', 1)], [util('a', { cpuLimit: 0, memoryRequest: 0 })]);
    expect(out[0]!.cpu.limit).toBeNull();
    expect(out[0]!.memory.request).toBeNull();
    // The ones that were declared survive untouched.
    expect(out[0]!.cpu.request).toBe(1);
    expect(out[0]!.memory.limit).toBe(400);
  });

  it('carries a null pod count through as null rather than as zero', () => {
    const out = mergeNamespaceUsage([nsRow('a', null)], [util('a')]);
    expect(out[0]!.pods).toBeNull();
  });

  it('leaves an unmeasured namespace with no meters when the workloads read has not landed', () => {
    const out = mergeNamespaceUsage([nsRow('a', 3)], null);
    expect(out[0]!.measured).toBe(false);
    expect(out[0]!.podsMeasured).toBe(0);
    expect(out[0]!.pods).toBe(3);
  });
});

describe('meterGeometry', () => {
  it('scales the track to the largest of the three so a burst stays on the track', () => {
    const g = meterGeometry({ used: 4, request: 1, limit: 2 });
    expect(g.scale).toBe(4);
    expect(g.usedPct).toBe(100);
    expect(g.requestPct).toBe(25);
    expect(g.limitPct).toBe(50);
  });

  it('plots a namespace that declared no limit', () => {
    const g = meterGeometry({ used: 1, request: 2, limit: null });
    expect(g.scale).toBe(2);
    expect(g.limitPct).toBeNull();
    expect(g.usedPct).toBe(50);
  });

  it('draws nothing at all rather than dividing by zero', () => {
    expect(meterGeometry({ used: null, request: null, limit: null })).toEqual({
      scale: null,
      usedPct: 0,
      requestPct: null,
      limitPct: null
    });
  });

  it('gives an unread usage a zero-width fill, not a full track', () => {
    const g = meterGeometry({ used: null, request: 2, limit: 4 });
    expect(g.usedPct).toBe(0);
    expect(g.scale).toBe(4);
  });
});

describe('pctOf', () => {
  it('refuses a zero or missing denominator instead of returning Infinity', () => {
    expect(pctOf(1, 0)).toBeNull();
    expect(pctOf(1, null)).toBeNull();
    expect(pctOf(null, 4)).toBeNull();
  });
  it('rounds to a whole percent', () => {
    expect(pctOf(1, 3)).toBe(33);
  });
});

describe('usageVerdict', () => {
  it('says nothing when usage sits inside both declarations', () => {
    expect(usageVerdict('cpu', { used: 0.5, request: 1, limit: 2 })).toEqual({
      tone: 'ok',
      level: 'normal',
      label: null,
      detail: null
    });
  });

  it('ranks the four states on one ladder: above request < near limit < at limit', () => {
    expect(usageVerdict('memory', { used: 60, request: 50, limit: 100 }).level).toBe('above-request');
    expect(usageVerdict('memory', { used: 85, request: 50, limit: 100 }).level).toBe('near-limit');
    expect(usageVerdict('memory', { used: 100, request: 50, limit: 100 }).level).toBe('at-limit');
    expect(usageVerdict('cpu', { used: 0.96, request: 0.5, limit: 1 }).level).toBe('near-limit');
    expect(usageVerdict('cpu', { used: 1.2, request: 0.5, limit: 1 }).level).toBe('at-limit');
    expect(usageVerdict('memory', { used: null, request: 50, limit: 100 }).level).toBe('unknown');
  });

  it('approaching a limit is the stronger warning, and only reaching it is critical', () => {
    expect(usageVerdict('memory', { used: 85, request: 50, limit: 100 }).tone).toBe('warn');
    expect(usageVerdict('memory', { used: 100, request: 50, limit: 100 }).tone).toBe('bad');
  });

  it('a limit only some pods declared is printed as a floor and never graded', () => {
    // One unlimited pod at 2 GiB beside a 256 MiB-limited one: summed limit 256, summed use 2248.
    const f = { used: 2248, request: null, limit: 256, limitPartial: true };
    expect(usageVerdict('memory', f).level).toBe('normal');
    expect(figuresText(f, n => String(n))).toBe('used 2248 · req none · lim ≥256');
    expect(usageVerdict('memory', { ...f, limitPartial: false }).level).toBe('at-limit');
  });

  it('an undeclared request never earns "Above request", however high the usage', () => {
    const v = usageVerdict('cpu', { used: 5, request: null, limit: null });
    expect(v.level).toBe('normal');
    expect(v.label).toBeNull();
  });

  it('calls a burst "Above request" and keeps it amber, never an error', () => {
    const v = usageVerdict('cpu', { used: 1.5, request: 1, limit: 4 });
    expect(v.label).toBe('Above request');
    expect(v.tone).toBe('warn');
    expect(v.detail).not.toMatch(/error/i);
  });

  it('flags memory at 80% of its limit as near-limit — the stronger warning, since an OOMKill is next', () => {
    expect(usageVerdict('memory', { used: 80, request: 50, limit: 100 })).toMatchObject({ tone: 'warn', level: 'near-limit' });
    expect(usageVerdict('memory', { used: 79, request: 50, limit: 100 }).level).not.toBe('near-limit');
  });

  it('flags CPU only at 95% of its limit, and as a warning, because the kernel throttles rather than kills', () => {
    expect(usageVerdict('cpu', { used: 0.94, request: 0.5, limit: 1 }).label).toBe('Above request');
    const v = usageVerdict('cpu', { used: 0.96, request: 0.5, limit: 1 });
    expect(v.label).toBe('Throttling likely');
    expect(v.tone).toBe('warn');
  });

  it('reaching the limit outranks being above the request', () => {
    const v = usageVerdict('cpu', { used: 2, request: 1, limit: 2 });
    expect(v.label).toBe('At limit');
    expect(v.tone).toBe('bad');
  });

  it('an unread sample is unknown, not ok', () => {
    const v = usageVerdict('memory', { used: null, request: 200, limit: 400 });
    expect(v.tone).toBe('unknown');
    expect(v.label).toBe('No sample');
  });

  it('grades on the request alone when nothing declared a limit', () => {
    expect(usageVerdict('memory', { used: 300, request: 200, limit: null }).label).toBe('Above request');
    expect(usageVerdict('memory', { used: 100, request: 200, limit: null }).label).toBeNull();
  });
});

describe('figuresText', () => {
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(n));

  it('names each figure and prints "none" where nothing was declared', () => {
    expect(figuresText({ used: 1, request: null, limit: null }, fmt)).toBe('used 1 · req none · lim none');
  });

  it('prints an em dash for an unread usage rather than a zero', () => {
    expect(figuresText({ used: null, request: 2, limit: 4 }, fmt)).toBe('used — · req 2 · lim 4');
  });
});

const base: NamespaceUsage = {
  namespace: 'a',
  system: false,
  pods: 10,
  podsMeasured: 10,
  usageMissing: 0,
  cpu: { used: 1, request: 1, limit: 1 },
  memory: { used: 1, request: 1, limit: 1 },
  restarts: 0,
  oomKilled: 0,
  measured: true
};

describe('coverageNote', () => {
  it('stays silent when the figures cover every pod', () => {
    expect(coverageNote(base)).toBeNull();
  });

  it('reports pods outside the workload selectors', () => {
    expect(coverageNote({ ...base, podsMeasured: 7 })).toMatch(/3 of 10 pods/);
  });

  it('reports a missing sample separately, because it makes usage a floor rather than absent', () => {
    const note = coverageNote({ ...base, usageMissing: 2 });
    expect(note).toMatch(/floor/);
    expect(note).not.toMatch(/not selected/);
  });

  it('says both when both are true', () => {
    const note = coverageNote({ ...base, podsMeasured: 7, usageMissing: 2 });
    expect(note).toMatch(/not selected/);
    expect(note).toMatch(/floor/);
  });

  it('claims no shortfall when the pod count itself is unknown', () => {
    expect(coverageNote({ ...base, pods: null, podsMeasured: 0 })).toBeNull();
  });
});

describe('ofRequestText', () => {
  it('distinguishes an undeclared request from an unread sample', () => {
    expect(ofRequestText({ used: 1, request: null, limit: null })).toBe('no request configured');
    expect(ofRequestText({ used: null, request: 2, limit: null })).toBe('no sample');
    expect(ofRequestText({ used: null, request: null, limit: null })).toBe('not measured');
  });

  it('always names the denominator', () => {
    expect(ofRequestText({ used: 1, request: 2, limit: null })).toBe('50% of request');
  });

  it('never renders a live sample as 0%', () => {
    // 0.4% of the request is a running namespace, and `0% of request` reads as an idle one.
    expect(ofRequestText({ used: 0.004, request: 1, limit: null })).toBe('<1% of request');
    // A genuine zero is still a zero.
    expect(ofRequestText({ used: 0, request: 1, limit: null })).toBe('0% of request');
  });
});

describe('restartsText', () => {
  const n = (restarts: number | null): NamespaceUsage => ({ ...base, restarts });

  it('stays silent at zero and at unknown', () => {
    expect(restartsText(n(0))).toBeNull();
    expect(restartsText(n(null))).toBeNull();
  });

  it('groups a large sum and says what it is a sum of', () => {
    const t = restartsText(n(37431));
    expect(t).toMatch(/37,431/);
    expect(t).toMatch(/summed/);
  });
});

describe('podsLabel', () => {
  it('singularises exactly one pod and nothing else', () => {
    expect(podsLabel(1)).toBe('pod');
    expect(podsLabel(0)).toBe('pods');
    expect(podsLabel(2)).toBe('pods');
    // An unknown count is not one pod.
    expect(podsLabel(null)).toBe('pods');
  });
});
