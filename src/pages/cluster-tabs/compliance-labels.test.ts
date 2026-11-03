import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CHART,
  BOOTSTRAP_VERDICT_LABEL,
  bootstrapCheckName,
  bootstrapCheckNote,
  bootstrapSummary
} from './compliance-labels';

describe('bootstrap compliance labels', () => {
  it('never says Compliant — the word reads as certification against a standard nobody named', () => {
    for (const label of Object.values(BOOTSTRAP_VERDICT_LABEL)) {
      expect(label).not.toMatch(/compliant/i);
    }
    expect(BOOTSTRAP_VERDICT_LABEL.compliant).toBe('Conventions present');
    expect(BOOTSTRAP_VERDICT_LABEL.findings).toBe('Conventions missing');
  });

  /*
    The map alone was not enough. Renaming BOOTSTRAP_VERDICT_LABEL left the roll-up strip above the
    rows printing a green `Compliant 28` in ClusterDetail.tsx, directly under prose saying this is
    not a certification — and this suite stayed green because it only ever iterated the map. The
    word has to be absent from the screen, so the assertion has to read the screen.
  */
  it('never prints the word Compliant on the compliance screen either, nor tones that figure green', () => {
    const src = readFileSync(new URL('../ClusterDetail.tsx', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    expect(/>\s*Compliant\s*</.test(code)).toBe(false);
    // The count of namespaces where every convention is present must not be text-ok: green is the
    // certification claim, whatever the label beside it says. Checked over the 200 characters
    // before the figure, which is the element that wraps it.
    const at = code.indexOf('rollup.compliant');
    expect(at, 'the roll-up figure is gone — update this guard').toBeGreaterThan(-1);
    expect(code.slice(Math.max(0, at - 200), at)).not.toContain('text-ok');
  });

  it('names the chart the checks come from', () => {
    expect(BOOTSTRAP_CHART).toBe('namespace-bootstrapping');
  });

  it('counts present conventions, with na out of the denominator', () => {
    expect(
      bootstrapSummary([
        { status: 'pass' },
        { status: 'pass' },
        { status: 'warn' },
        { status: 'fail' },
        { status: 'pass' }
      ])
    ).toBe('Bootstrap conventions — 3/5 present');
    expect(bootstrapSummary([{ status: 'pass' }, { status: 'na' }])).toBe('Bootstrap conventions — 1/1 present');
    expect(bootstrapSummary([{ status: 'na' }])).toBe('Bootstrap conventions — none applicable');
    expect(bootstrapSummary([])).toBe('Bootstrap conventions — none applicable');
  });

  it('restates PSA as the label it actually read, not a workload verdict', () => {
    expect(bootstrapCheckName('psa', 'PSA baseline')).toBe('PSA enforce label set');
    expect(bootstrapCheckNote('psa')).toContain('admission');
    expect(bootstrapCheckNote('psa')).toContain('warn/audit');
  });

  it('qualifies the istio check as a label, not a live mTLS verdict', () => {
    expect(bootstrapCheckNote('istio')).toContain('mesh policy verdict');
  });

  it('leaves every other check name and note alone', () => {
    expect(bootstrapCheckName('pullSecret', 'Pull secret')).toBe('Pull secret');
    expect(bootstrapCheckNote('pullSecret')).toBeNull();
    expect(bootstrapCheckNote('egress')).toBeNull();
  });
});
