/**
 * Theme preference resolution.
 *
 * The DOM-touching half (`applyTheme`, `initTheme`) is not covered here — this project's vitest
 * runs without a DOM environment on purpose (jsdom is unavailable from the registry, see the
 * project notes) and the interesting behaviour is the three-state preference logic anyway, which
 * is where a two-state boolean would have gone wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTheme, readPref, resolve, writePref } from './theme';

/** A minimal localStorage that can also be made to throw, which is the private-window case. */
function fakeStorage({ throws = false } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => {
      if (throws) throw new Error('access denied');
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('access denied');
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (throws) throw new Error('access denied');
      map.delete(k);
    }
  };
}

function install(storage: ReturnType<typeof fakeStorage>) {
  vi.stubGlobal('localStorage', storage);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('readPref', () => {
  it('defaults to system when nothing is stored', () => {
    install(fakeStorage());
    expect(readPref()).toBe('system');
  });

  it('returns a stored explicit choice', () => {
    const s = fakeStorage();
    install(s);
    writePref('light');
    expect(readPref()).toBe('light');
    writePref('dark');
    expect(readPref()).toBe('dark');
  });

  it('falls back to system rather than trusting a hand-edited value', () => {
    const s = fakeStorage();
    s.map.set('kyma-fleet:theme', 'solarized');
    install(s);
    expect(readPref()).toBe('system');
  });

  it('survives a storage that throws, which is the private-window case', () => {
    install(fakeStorage({ throws: true }));
    expect(readPref()).toBe('system');
    // And a refused write must not propagate — the toggle still has to work for the session.
    expect(() => writePref('light')).not.toThrow();
  });

  it('removes the key for system rather than storing the string', () => {
    const s = fakeStorage();
    install(s);
    writePref('dark');
    expect(s.map.has('kyma-fleet:theme')).toBe(true);
    writePref('system');
    expect(s.map.has('kyma-fleet:theme')).toBe(false);
  });
});

describe('resolve', () => {
  it('honours an explicit choice regardless of the OS', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(resolve('dark')).toBe('dark');
    expect(resolve('light')).toBe('light');
  });

  it('follows the OS for system', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('light') }));
    expect(resolve('system')).toBe('light');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(resolve('system')).toBe('dark');
  });

  it('falls back to dark where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(resolve('system')).toBe('dark');
  });
});

describe('nextTheme', () => {
  it('is a two-position cycle that never stops on system', () => {
    // Cycling through `system` would make one press in three appear to do nothing whenever the
    // OS already matches, which reads as a broken button.
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme(nextTheme('dark'))).toBe('dark');
  });
});
