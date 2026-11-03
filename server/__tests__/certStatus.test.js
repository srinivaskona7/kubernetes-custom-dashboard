import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  splitPemCertificates,
  parseDistinguishedName,
  parseSubjectAltName,
  extractAprns,
  certificateState,
  describeCertificate,
  overallStatus,
  readCertStatus,
} from '../lib/certStatus.js';

const APRN = 'aprn:apple:narrative::aws:actor:btp-kyma-fleet-dashboard';

describe('splitPemCertificates', () => {
  it('returns each PEM block in order', () => {
    const a = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----';
    const b = '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----';
    expect(splitPemCertificates(`${a}\n${b}\n`)).toEqual([a, b]);
  });

  it('returns an empty array when there is no certificate', () => {
    expect(splitPemCertificates('not a cert')).toEqual([]);
    expect(splitPemCertificates('')).toEqual([]);
  });
});

describe('parseDistinguishedName', () => {
  it('parses Node newline-separated DNs, keeping "=" inside values', () => {
    expect(parseDistinguishedName('CN=svc\nOU=a=b\nO=Apple')).toEqual({ CN: 'svc', OU: 'a=b', O: 'Apple' });
  });

  it('tolerates empty input', () => {
    expect(parseDistinguishedName(undefined)).toEqual({});
  });
});

describe('parseSubjectAltName / extractAprns', () => {
  it('splits typed entries and keeps colons in values', () => {
    const san = parseSubjectAltName(`DNS:svc.local, URI:${APRN}`);
    expect(san).toEqual([{ type: 'DNS', value: 'svc.local' }, { type: 'URI', value: APRN }]);
    expect(extractAprns(san)).toEqual([APRN]);
  });

  it('returns no entries for a missing SAN', () => {
    expect(parseSubjectAltName(undefined)).toEqual([]);
    expect(extractAprns([])).toEqual([]);
  });
});

describe('certificateState', () => {
  const cert = { validFrom: '2026-01-01T00:00:00Z', validTo: '2026-01-11T00:00:00Z' }; // 10 days

  it('is valid early in the lifetime', () => {
    expect(certificateState(cert, new Date('2026-01-02T00:00:00Z'))).toBe('valid');
  });

  it('is expiring in the last 20% of the lifetime', () => {
    expect(certificateState(cert, new Date('2026-01-09T12:00:00Z'))).toBe('expiring');
  });

  it('is expired at or after validTo', () => {
    expect(certificateState(cert, new Date('2026-01-11T00:00:00Z'))).toBe('expired');
  });

  it('is not-yet-valid before validFrom', () => {
    expect(certificateState(cert, new Date('2025-12-31T00:00:00Z'))).toBe('not-yet-valid');
  });
});

describe('describeCertificate', () => {
  it('extracts CN, APRNs, issuer CN, and remaining hours', () => {
    const d = describeCertificate({
      subject: 'CN=btp-kyma-fleet-dashboard\nO=Apple',
      issuer: 'CN=Narrative Actor CA\nO=Apple',
      subjectAltName: `URI:${APRN}`,
      serialNumber: '01',
      fingerprint256: 'AA:BB',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: '2026-01-02T00:00:00Z',
    }, new Date('2026-01-01T12:00:00Z'));
    expect(d).toMatchObject({
      commonName: 'btp-kyma-fleet-dashboard',
      aprns: [APRN],
      issuerCommonName: 'Narrative Actor CA',
      hoursRemaining: 12,
      state: 'valid',
    });
  });
});

describe('overallStatus', () => {
  it('maps leaf state and key match to a single status', () => {
    expect(overallStatus({ leaf: null })).toBe('missing');
    expect(overallStatus({ leaf: { state: 'valid' }, keyMatches: true })).toBe('ok');
    expect(overallStatus({ leaf: { state: 'valid' }, keyMatches: null })).toBe('ok');
    expect(overallStatus({ leaf: { state: 'expiring' }, keyMatches: true })).toBe('warn');
    expect(overallStatus({ leaf: { state: 'expired' }, keyMatches: true })).toBe('fail');
    expect(overallStatus({ leaf: { state: 'valid' }, keyMatches: false })).toBe('fail');
  });
});

describe('readCertStatus', () => {
  let dir;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'certstatus-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports missing when the cert path is unset or absent', async () => {
    expect((await readCertStatus({ certPath: undefined })).status).toBe('missing');
    expect((await readCertStatus({ certPath: join(dir, 'nope.crt') })).status).toBe('missing');
  });

  it('fails when the file holds no PEM certificate', async () => {
    const p = join(dir, 'garbage.crt');
    writeFileSync(p, 'hello');
    expect((await readCertStatus({ certPath: p })).status).toBe('fail');
  });

  it('reports a fail instead of throwing on a corrupt (e.g. half-rotated) PEM', async () => {
    const p = join(dir, 'corrupt.crt');
    writeFileSync(p, '-----BEGIN CERTIFICATE-----\nnot-base64-der\n-----END CERTIFICATE-----\n');
    const s = await readCertStatus({ certPath: p });
    expect(s.status).toBe('fail');
    expect(s.detail).toMatch(/Could not read/);
  });

  it('fails when the cert path is unreadable (a directory)', async () => {
    const s = await readCertStatus({ certPath: dir });
    expect(s.status).toBe('fail');
  });

  let hasOpenssl = true;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

  it.skipIf(!hasOpenssl)('reads a real cert, its APRN, and confirms the key matches', async () => {
    const certPath = join(dir, 'tls.crt');
    const keyPath = join(dir, 'tls.key');
    const otherKey = join(dir, 'other.key');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/CN=btp-kyma-fleet-dashboard', '-addext', `subjectAltName=URI:${APRN}`,
    ], { stdio: 'ignore' });
    execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-out', otherKey], { stdio: 'ignore' });

    const s = await readCertStatus({ certPath, keyPath, caPath: certPath });
    expect(s.status).toBe('ok');
    expect(s.keyMatches).toBe(true);
    expect(s.leaf.commonName).toBe('btp-kyma-fleet-dashboard');
    expect(s.leaf.aprns).toEqual([APRN]);
    expect(s.ca).toHaveLength(1);
    expect(s.caError).toBeNull();

    const mismatched = await readCertStatus({ certPath, keyPath: otherKey });
    expect(mismatched.status).toBe('fail');
    expect(mismatched.keyMatches).toBe(false);

    // A corrupt CA bundle is surfaced but does not mask the leaf status.
    const badCa = join(dir, 'bad-ca.crt');
    writeFileSync(badCa, '-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----\n');
    const withBadCa = await readCertStatus({ certPath, keyPath, caPath: badCa });
    expect(withBadCa.status).toBe('ok');
    expect(withBadCa.ca).toEqual([]);
    expect(withBadCa.caError).toMatch(/Could not read/);
  });
});
