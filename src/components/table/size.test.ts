/**
 * The identity-column floor. See `size.ts` for why a constant was not enough.
 */
import { describe, expect, it } from 'vitest';
import { MIN_IDENTITY_PX, identityFloorPx, pxOf } from './size';

describe('pxOf', () => {
  it('reads a px length', () => {
    expect(pxOf('78px')).toBe(78);
    expect(pxOf(' 220px ')).toBe(220);
    expect(pxOf('12.5px')).toBe(12.5);
  });

  it('declines anything it cannot compare against a px floor', () => {
    // Not a failure: null means "no opinion", and the caller falls back to the plain floor rather
    // than inventing a conversion that would need a layout to be right.
    expect(pxOf('50%')).toBeNull();
    expect(pxOf('20ch')).toBeNull();
    expect(pxOf('6rem')).toBeNull();
    expect(pxOf('auto')).toBeNull();
    expect(pxOf(undefined)).toBeNull();
    expect(pxOf('')).toBeNull();
  });
});

describe('identityFloorPx', () => {
  it('is the default when the column declares no size', () => {
    expect(identityFloorPx(undefined, undefined)).toBe(MIN_IDENTITY_PX);
  });

  it('never exceeds a narrower declared width', () => {
    // The regression this exists for: Traffic's `Code` column is a three-digit status pill declared
    // at 78px. Widening it to 120 pushed that eight-column row 41px past its container at 1280.
    expect(identityFloorPx('78px', undefined)).toBe(78);
    expect(identityFloorPx('70px', undefined)).toBe(70);
  });

  it('never exceeds a declared ceiling', () => {
    // A minWidth above maxWidth is a contradiction the browser resolves by ignoring the max, which
    // is exactly the overflow the ceiling was added to prevent.
    expect(identityFloorPx(undefined, '90px')).toBe(90);
    expect(identityFloorPx('100px', '90px')).toBe(90);
  });

  it('keeps the full floor for a wide name column', () => {
    // A pod-name column capped at 300px still needs its floor — this is the case the floor is for.
    expect(identityFloorPx('300px', '300px')).toBe(MIN_IDENTITY_PX);
    expect(identityFloorPx(undefined, '210px')).toBe(MIN_IDENTITY_PX);
  });

  it('ignores a unit it cannot compare, rather than dropping the floor', () => {
    expect(identityFloorPx('30%', undefined)).toBe(MIN_IDENTITY_PX);
  });
});
