import { readFile } from 'fs/promises';
import { X509Certificate, createPrivateKey } from 'crypto';

// Narrative identity status for the Status page. The CSI driver mounts the
// pod's identity at /tls (tls.crt, tls.key, ca.crt) and rotates it in place,
// so every call re-reads the files. Only public certificate fields are
// returned; the private key is read solely to confirm it matches the cert.

// Narrative certs are short-lived and rotated automatically, so "expiring" is
// a fraction of the cert's own lifetime rather than a fixed number of days.
export const WARN_REMAINING_FRACTION = 0.2;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function splitPemCertificates(pem) {
  return String(pem).match(PEM_BLOCK) ?? [];
}

// "CN=foo\nOU=bar" (Node's X509Certificate format) → { CN: 'foo', OU: 'bar' }
export function parseDistinguishedName(dn) {
  const fields = {};
  for (const line of String(dn ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

// "DNS:a, URI:aprn:apple:narrative:..." → [{ type: 'DNS', value: 'a' }, ...]
export function parseSubjectAltName(san) {
  if (!san) return [];
  return san.split(/,\s*/).map(entry => {
    const i = entry.indexOf(':');
    return i > 0 ? { type: entry.slice(0, i), value: entry.slice(i + 1) } : { type: '', value: entry };
  });
}

export function extractAprns(sanEntries) {
  return sanEntries.map(e => e.value).filter(v => /^aprn:/i.test(v));
}

export function certificateState({ validFrom, validTo }, now = new Date()) {
  const from = new Date(validFrom).getTime();
  const to = new Date(validTo).getTime();
  const t = now.getTime();
  if (t < from) return 'not-yet-valid';
  if (t >= to) return 'expired';
  if ((to - t) / (to - from) < WARN_REMAINING_FRACTION) return 'expiring';
  return 'valid';
}

export function describeCertificate(cert, now = new Date()) {
  const subject = parseDistinguishedName(cert.subject);
  const issuer = parseDistinguishedName(cert.issuer);
  const san = parseSubjectAltName(cert.subjectAltName);
  const validTo = new Date(cert.validTo);
  return {
    commonName: subject.CN ?? null,
    aprns: extractAprns(san),
    subject: cert.subject,
    subjectFields: subject,
    subjectAltNames: san,
    issuer: cert.issuer,
    issuerCommonName: issuer.CN ?? null,
    serialNumber: cert.serialNumber,
    fingerprint256: cert.fingerprint256,
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    hoursRemaining: Math.round(((validTo.getTime() - now.getTime()) / 36e5) * 10) / 10,
    state: certificateState(cert, now),
  };
}

// Overall status for the identity: worst of the leaf state and key match.
export function overallStatus({ leaf, keyMatches }) {
  if (!leaf) return 'missing';
  if (leaf.state === 'expired' || leaf.state === 'not-yet-valid' || keyMatches === false) return 'fail';
  if (leaf.state === 'expiring') return 'warn';
  return 'ok';
}

// Resolves to the file contents, or null when the path is unset or absent.
async function readOptional(path, encoding) {
  if (!path) return null;
  try {
    return await readFile(path, encoding);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function failure(detail, paths, extra = {}) {
  return { status: 'fail', detail, paths, leaf: null, chain: [], ca: [], keyMatches: null, ...extra };
}

export async function readCertStatus({ certPath, keyPath, caPath, now = new Date() }) {
  const paths = { certPath, keyPath: keyPath || null, caPath: caPath || null };

  // Narrative rotates these files in place, so a read can race a partial
  // write; any read/parse error is reported as a failed check, never thrown.
  let leafCert, leaf, chain;
  try {
    const certPem = await readOptional(certPath, 'utf8');
    if (certPem == null) {
      return { status: 'missing', detail: `No certificate at ${certPath || '(unset)'}`, paths, leaf: null, chain: [], ca: [], keyMatches: null };
    }
    const [leafPem, ...chainPems] = splitPemCertificates(certPem);
    if (!leafPem) return failure(`${certPath} contains no PEM certificate`, paths);
    leafCert = new X509Certificate(leafPem);
    leaf = describeCertificate(leafCert, now);
    chain = chainPems.map(p => describeCertificate(new X509Certificate(p), now));
  } catch (err) {
    return failure(`Could not read ${certPath}: ${err.message}`, paths);
  }

  let keyMatches = null;
  try {
    const keyPem = await readOptional(keyPath);
    if (keyPem != null) keyMatches = leafCert.checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    keyMatches = false;
  }

  // A bad CA bundle should not hide the identity cert's own status.
  let ca = [];
  let caError = null;
  try {
    const caPem = await readOptional(caPath, 'utf8');
    if (caPem != null) ca = splitPemCertificates(caPem).map(p => describeCertificate(new X509Certificate(p), now));
  } catch (err) {
    caError = `Could not read ${caPath}: ${err.message}`;
  }

  const status = overallStatus({ leaf, keyMatches });
  const detail = {
    ok: `Valid until ${leaf.validTo}`,
    warn: `Expiring soon (${leaf.hoursRemaining}h left); Narrative should rotate it automatically`,
    fail: keyMatches === false ? 'Private key does not match the certificate' : `Certificate is ${leaf.state}`,
  }[status];

  return { status, detail, paths, leaf, chain, ca, caError, keyMatches };
}
