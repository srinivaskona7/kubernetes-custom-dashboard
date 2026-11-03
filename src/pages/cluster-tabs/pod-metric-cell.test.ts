import { describe, expect, it } from 'vitest';
import { bytes, cpu } from '../../format';
import { isUnbounded, limitText, metricTitle, requestText, usedText } from './pod-metric-cell';

describe('usedText', () => {
  /*
    The assertion this module exists for. `bytes(null)` is the string '0', so a cell that formats a
    missing sample directly reports a pod using no memory on a cluster whose metrics-server is down —
    a confident zero where the honest answer is "not measured". Pinned against the real formatter
    rather than a stub, because a stub would let format.ts change under it.
  */
  it('never turns a missing sample into a zero, for either formatter', () => {
    expect(bytes(null)).toBe('0');
    expect(usedText(null, bytes)).toBe('—');
    expect(usedText(undefined, bytes)).toBe('—');
    expect(usedText(null, cpu)).toBe('—');
  });

  it('passes a real sample through, including a true zero', () => {
    expect(usedText(0, bytes)).toBe('0');
    expect(usedText(1024, bytes)).toBe('1.0 KiB');
    expect(usedText(0.009, cpu)).toBe('9m');
  });
});

describe('limitText', () => {
  it('reads a zero limit as none, because a pod with no ceiling is unbounded, not idle', () => {
    expect(limitText(0, bytes)).toBe('none');
    expect(limitText(0, cpu)).toBe('none');
  });

  it('distinguishes an unset limit from an unread one', () => {
    // 'none' is a reported fact: the spec declares no limit. An em dash is the absence of a read.
    expect(limitText(0, cpu)).toBe('none');
    expect(limitText(null, cpu)).toBe('—');
  });

  it('formats a real limit', () => {
    expect(limitText(536870912, bytes)).toBe('512 MiB');
    expect(limitText(0.5, cpu)).toBe('500m');
  });
});

describe('requestText', () => {
  /*
    Found by rendering, not by reasoning. On the live sbx cluster the one BestEffort pod printed
    `1m / 0 / none` and `58 MiB / 0 / none` — the `0` was the most load-bearing figure in the row and
    the only one printed as a plain number. A request is a sum over the pod's containers, so 0 means
    no container declared one, which is precisely what makes the pod BestEffort and first to be
    evicted. Requests get the same treatment as limits for the same reason.
  */
  it('reads a zero request as none, because that is what makes a pod BestEffort', () => {
    expect(requestText(0, cpu)).toBe('none');
    expect(requestText(0, bytes)).toBe('none');
  });

  it('still separates an undeclared request from an unread one', () => {
    expect(requestText(null, bytes)).toBe('—');
  });

  it('formats a real request', () => {
    expect(requestText(0.5, cpu)).toBe('500m');
    expect(requestText(536870912, bytes)).toBe('512 MiB');
  });
});

describe('isUnbounded', () => {
  it('is true only for a declared-and-zero limit', () => {
    expect(isUnbounded(0)).toBe(true);
    expect(isUnbounded(null)).toBe(false);
    expect(isUnbounded(undefined)).toBe(false);
    expect(isUnbounded(1)).toBe(false);
  });
});

describe('metricTitle', () => {
  it('names which value is which, since the cell itself is three bare numbers', () => {
    expect(metricTitle('CPU', '9m', '100m', '500m')).toBe('CPU: using 9m, requests 100m, limit 500m');
  });

  it('explains the consequence of an absent memory limit in terms of OOMKill', () => {
    const t = metricTitle('Memory', '130 MiB', '256 MiB', 'none');
    expect(t).toContain('no memory limit is declared');
    expect(t).toContain('OOMKill');
    expect(t).toContain('evicted on node pressure');
  });

  it('explains an absent CPU limit as throttling, not as killing — CPU is compressible', () => {
    const t = metricTitle('CPU', '9m', '100m', 'none');
    expect(t).toContain('never throttled');
    expect(t).not.toContain('OOMKill');
  });
});
