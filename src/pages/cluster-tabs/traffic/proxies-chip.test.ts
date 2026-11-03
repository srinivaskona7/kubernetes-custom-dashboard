import { describe, expect, it } from 'vitest';
import { proxiesChipText } from './ProxiesRead';

describe('proxiesChipText', () => {
  it('states read of candidates', () => {
    expect(proxiesChipText({ proxiesRead: 12, proxyCandidates: 41, proxiesFailed: [] })).toEqual({ text: '12 of 41 proxies read', tone: 'muted' });
  });
  it('warns on failed reads', () => {
    expect(proxiesChipText({ proxiesRead: 10, proxyCandidates: 41, proxiesFailed: [{}, {}] })).toEqual({ text: '10 of 41 proxies read · 2 failed', tone: 'warn' });
  });
  it('says nothing was read when the read was skipped, never "0 of N"', () => {
    expect(proxiesChipText({ proxiesRead: 0, proxyCandidates: 41, readsSkipped: true, proxiesFailed: [] })).toEqual({ text: 'No proxy read', tone: 'warn' });
  });
  it('is quiet before the first answer', () => {
    expect(proxiesChipText(undefined)).toEqual({ text: 'Proxies read', tone: 'muted' });
  });
});
