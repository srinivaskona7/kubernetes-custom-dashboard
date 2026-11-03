import { describe, expect, test } from 'vitest';
import {
  NOT_REPORTED,
  capacityLabel,
  pvcCapacityBytes,
  pvcSearchText,
  quotaDimensionLabel,
  quotaSourceNote,
  quotaSourceTone,
  storageClassIsAbsent,
  storageClassLabel
} from './storage-cells';

describe('PVC capacity sorting', () => {
  test('sorts on the parsed bytes, so 512Mi does not outrank 4Gi', () => {
    const half = pvcCapacityBytes({ capacityBytes: 512 * 1024 * 1024 });
    const four = pvcCapacityBytes({ capacityBytes: 4 * 1024 * 1024 * 1024 });
    expect(half).toBe(536870912);
    expect(four).toBe(4294967296);
    expect(Number(half) < Number(four)).toBe(true);
    // The string the column renders ranks them the other way round, which is the bug this guards.
    expect('512Mi' > '4Gi').toBe(true);
  });

  test('an unbound claim has no sort key at all, not a zero-byte volume', () => {
    expect(pvcCapacityBytes({ capacityBytes: null })).toBeNull();
    expect(pvcCapacityBytes({})).toBeNull();
  });
});

describe('PVC capacity', () => {
  test('a reported bound capacity is printed as given', () => {
    expect(capacityLabel('20Gi')).toBe('20Gi');
  });

  test('an unreported capacity says so and never borrows the request', () => {
    expect(capacityLabel(null)).toBe(NOT_REPORTED);
    expect(capacityLabel(undefined)).toBe(NOT_REPORTED);
    expect(capacityLabel('')).toBe(NOT_REPORTED);
    expect(NOT_REPORTED).toContain('not reported');
    expect(NOT_REPORTED).not.toMatch(/\d/);
  });
});

describe('PVC StorageClass', () => {
  test('a claim naming no class does not claim a class called "default"', () => {
    expect(storageClassLabel(null)).toBe('none set (cluster default applies)');
    expect(storageClassLabel(null)).not.toBe('default');
    expect(storageClassIsAbsent(null)).toBe(true);
  });

  test('a class actually named "default" is still shown as itself, and is not the absent state', () => {
    expect(storageClassLabel('default')).toBe('default');
    expect(storageClassIsAbsent('default')).toBe(false);
    expect(storageClassLabel('default')).not.toBe(storageClassLabel(null));
  });

  test('an explicitly empty storageClassName is its own state, not absent-by-omission', () => {
    expect(storageClassLabel('')).toBe('explicitly empty (no dynamic provisioning)');
    expect(storageClassLabel('')).not.toBe(storageClassLabel(null));
  });

  test('search still matches the absent-class wording without throwing on null', () => {
    expect(pvcSearchText({ name: 'hana', namespace: 'prod', storageClass: null })).toContain('none set');
    expect(pvcSearchText({ name: 'hana', namespace: 'prod', storageClass: 'Premium' })).toContain('premium');
  });
});

describe('quota dimensions', () => {
  test('both halves present read as the ratio they are', () => {
    expect(quotaDimensionLabel('1', '4')).toBe('1 / 4');
  });

  test('an unreconciled used is "not reported", never 0', () => {
    expect(quotaDimensionLabel(null, '4')).toBe('not reported / 4');
    expect(quotaDimensionLabel(null, '4')).not.toContain('0 /');
  });

  test('a dimension the quota does not mention is not "unlimited"', () => {
    expect(quotaDimensionLabel('1', null)).toBe('1 / not in this quota');
    expect(quotaDimensionLabel('1', null)).not.toContain('unlimited');
  });

  test('a real zero stays a zero', () => {
    expect(quotaDimensionLabel('0', '4')).toBe('0 / 4');
  });
});

describe('quota hard source', () => {
  test('enforced numbers carry no caveat', () => {
    expect(quotaSourceNote('enforced')).toBeNull();
    expect(quotaSourceTone('enforced')).toBe('ok');
  });

  test('spec-only numbers are labelled as not yet enforced', () => {
    expect(quotaSourceNote('configured')).toContain('not yet enforced');
    expect(quotaSourceTone('configured')).toBe('warn');
  });

  test('no limits at all is unknown, not an enforced quota', () => {
    expect(quotaSourceNote(null)).toContain('no limits read');
    expect(quotaSourceTone(null)).toBe('unknown');
  });
});
