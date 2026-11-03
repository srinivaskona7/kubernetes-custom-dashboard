/**
 * The "what went wrong" explanations, tested for the property that matters: each one describes only
 * what was actually observed.
 *
 * Two failures this file exists to catch. A forecast that claims a kill already happened, and a
 * command template that ships with an unsubstituted placeholder — a copy button that hands an
 * operator `kubectl describe pod ${pod}` is worse than no button, because they paste it into a
 * production shell before reading it.
 */
import { describe, expect, it } from 'vitest';
import { DIAGNOSED_SUBJECTS, diagnose } from './diagnosis';

const where = { namespace: 'polls', pod: 'polls-frontend-abc', container: 'app' };

describe('diagnose — observed versus forecast', () => {
  it('states the kubelet’s OOM kill as something that happened', () => {
    const d = diagnose({ kind: 'oom-killed', ...where });
    expect(d.known).toBe(true);
    expect(d.summary).toMatch(/was killed|terminated/i);
    expect(d.summary).not.toMatch(/risk|may|could/i);
  });

  it('states an OOM forecast as a forecast, and never as a kill', () => {
    const d = diagnose({ kind: 'oom-risk', ...where, percent: 0.91, limit: '512Mi' });
    expect(d.known).toBe(true);
    expect(d.summary).toMatch(/91%/);
    expect(d.summary).toMatch(/512Mi/);
    // The word "killed" may only appear as a consequence that has not occurred yet.
    expect(d.summary).not.toMatch(/was killed/i);
  });

  it('distinguishes throttling from killing, because the remedy differs', () => {
    const d = diagnose({ kind: 'cpu-throttle', ...where, percent: 1.04, limit: '500m' });
    expect(d.summary).toMatch(/slow|throttl/i);
    // The copy is allowed to say it is *not* being killed or restarted — that is the distinction
    // itself. What it must never do is assert either as having happened.
    expect(d.summary).not.toMatch(/\bwas (killed|restarted|terminated)\b/i);
    expect(d.summary).toMatch(/not being restarted|not.*killed/i);
    expect(d.rootCause).toMatch(/quota|limit/i);
  });
});

describe('diagnose — HTTP outcomes', () => {
  it('separates a policy denial from a missing route, because they are fixed in different places', () => {
    const forbidden = diagnose({ kind: 'http', code: 403 });
    const missing = diagnose({ kind: 'http', code: 404 });
    expect(forbidden.rootCause).toMatch(/AuthorizationPolicy|RBAC|policy/i);
    expect(missing.rootCause).toMatch(/route|VirtualService|host/i);
    expect(forbidden.summary).not.toBe(missing.summary);
  });

  it('explains 502, 503 and 504 as three different upstream failures', () => {
    const summaries = [502, 503, 504].map(code => diagnose({ kind: 'http', code }).summary);
    expect(new Set(summaries).size).toBe(3);
    expect(diagnose({ kind: 'http', code: 504 }).summary).toMatch(/time|slow/i);
  });

  it('treats response code 0 as no HTTP response at all, not as a server error', () => {
    const d = diagnose({ kind: 'http', code: 0 });
    expect(d.summary).toMatch(/no HTTP response|never answered/i);
    expect(d.tone).toBe('unknown');
  });

  it('admits it has no guidance for a code it does not know, rather than inventing one', () => {
    const d = diagnose({ kind: 'http', code: 418 });
    expect(d.known).toBe(false);
    expect(d.rootCause).toMatch(/no specific guidance|does not have/i);
  });
});

describe('diagnose — commands', () => {
  it('substitutes the real namespace, pod and container into every command', () => {
    for (const kind of ['oom-killed', 'oom-risk', 'cpu-throttle', 'crashloop'] as const) {
      const d = diagnose({ kind, ...where, percent: 0.9, limit: '512Mi' });
      expect(d.commands.length).toBeGreaterThan(0);
      for (const cmd of d.commands) {
        expect(cmd, `${kind}: ${cmd}`).not.toMatch(/[$][{]|<[a-z-]+>/);
        expect(cmd).toContain('polls');
      }
    }
  });

  it('offers no pod command when there is no pod to name', () => {
    // An HTTP explanation is about a request, not a workload. A `kubectl describe pod` with a
    // guessed name is the one command on this screen that could send somebody to the wrong pod.
    const d = diagnose({ kind: 'http', code: 502 });
    expect(d.commands.every(c => !c.includes('describe pod'))).toBe(true);
  });
});

describe('the subject registry', () => {
  it('names every subject that has tailored copy, so the guard can enumerate them', () => {
    expect(DIAGNOSED_SUBJECTS).toContain('oom-killed');
    expect(DIAGNOSED_SUBJECTS).toContain('cpu-throttle');
    expect(DIAGNOSED_SUBJECTS).toContain('http:403');
    expect(DIAGNOSED_SUBJECTS).toContain('http:401');
  });

  it('explains a 401, the edge error Streamlit polling behind an approuter produces', () => {
    const d = diagnose({ kind: 'http', code: 401 });
    expect(d.known).toBe(true);
    expect(d.rootCause).toContain('via_upstream');
  });

  it('gives every subject a summary, a root cause and at least one next step', () => {
    const subjects = [
      { kind: 'oom-killed', ...where } as const,
      { kind: 'oom-risk', ...where, percent: 0.9, limit: '512Mi' } as const,
      { kind: 'cpu-throttle', ...where, percent: 1, limit: '1' } as const,
      { kind: 'crashloop', ...where } as const,
      ...[0, 403, 404, 502, 503, 504].map(code => ({ kind: 'http', code }) as const)
    ];
    for (const s of subjects) {
      const d = diagnose(s);
      expect(d.summary.length, JSON.stringify(s)).toBeGreaterThan(20);
      expect(d.rootCause.length, JSON.stringify(s)).toBeGreaterThan(20);
      expect(d.remediation.length, JSON.stringify(s)).toBeGreaterThan(0);
    }
  });
});
