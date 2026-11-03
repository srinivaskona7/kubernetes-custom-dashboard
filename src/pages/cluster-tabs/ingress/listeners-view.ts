/**
 * Ingress & Traffic → TLS & Listeners, the rules.
 *
 * The row mappers and searches behind the Gateway servers, Rejected before routing and Mesh mTLS
 * tables. No JSX here, so vitest's node environment can test every rule.
 */
import type { IngressCertificate, IngressGatewayServer, IngressRejection, TrafficIngress } from '../../../api';
import type { Tone } from '../../../components/ui';
import { certForServer, certTone, daysLeftText } from './edge-view';

type PeerAuth = NonNullable<TrafficIngress['access']>['peerAuthentications'][number];

const MTLS_WHY: Record<string, string> = {
  STRICT: 'Only mutual TLS is accepted.',
  PERMISSIVE: 'Mutual TLS and plaintext are both accepted, so a workload can be reached unencrypted.',
  DISABLE: 'Mutual TLS is off for the selected workloads.',
  UNSET: 'Inherits from the parent scope.'
};

export interface PeerAuthRow {
  key: string;
  name: string;
  /** The mode as declared, or `unset`. */
  mode: string;
  tone: Tone;
  why: string;
  /** The selector as `k=v` pairs, or `namespace-wide` when it selects nothing. */
  scope: string;
}

/** One PeerAuthentication as the Mesh mTLS table reads it. PERMISSIVE accepts plaintext, so it is amber. */
export function peerAuthRow(p: PeerAuth): PeerAuthRow {
  const labels = p.selector ? Object.entries(p.selector) : [];
  return {
    key: `${p.namespace}/${p.name}`,
    name: `${p.namespace}/${p.name}`,
    mode: p.mode ?? 'unset',
    tone: p.mode === 'PERMISSIVE' || p.mode === 'DISABLE' ? 'warn' : p.mode === 'STRICT' ? 'ok' : 'unknown',
    why: MTLS_WHY[p.mode ?? ''] ?? 'No mode set: the mesh default applies.',
    scope: labels.length ? labels.map(([k, v]) => `${k}=${v}`).join(', ') : 'namespace-wide'
  };
}

/**
 * How a Gateway's TLS mode should read.
 *
 * Only `DISABLE` is drawn as a warning, and `PASSTHROUGH` is not drawn as good or bad: it is correct
 * for a Gateway fronting a workload that terminates its own TLS. A missing block and an unrecognised
 * mode are `unknown`; violet is the brand, never a verdict.
 */
export function tlsTone(mode: string | null): Tone {
  if (mode === 'DISABLE') return 'warn';
  if (mode === 'SIMPLE' || mode === 'MUTUAL' || mode === 'ISTIO_MUTUAL') return 'ok';
  return 'unknown';
}

/** The Expiry cell of one Gateway server. `tone: null` means there is nothing to judge. */
export function serverExpiry(
  server: Pick<IngressGatewayServer, 'key' | 'credentialName'>,
  certs: { items: IngressCertificate[]; unavailable: boolean; reason?: string | null } | undefined
): { text: string; tone: Tone | null; title: string; daysLeft: number | null } {
  if (!server.credentialName) {
    return { text: '—', tone: null, daysLeft: null, title: 'This server names no credential, so there is no certificate at the gateway to expire.' };
  }
  if (!certs || certs.unavailable) {
    return { text: 'not read', tone: 'unknown', daysLeft: null, title: 'The Certificates read failed, so this Secret’s expiry is unknown.' };
  }
  const cert = certForServer(server, certs.items);
  if (!cert) {
    return { text: 'no Certificate found', tone: 'unknown', daysLeft: null, title: 'No cert-manager Certificate names this Secret, so its expiry is not readable here.' };
  }
  return {
    text: cert.ready === false ? 'not Ready' : daysLeftText(cert.daysLeft),
    tone: certTone(cert),
    daysLeft: cert.daysLeft ?? null,
    title: `Certificate ${cert.namespace}/${cert.name}${cert.expires ? `, notAfter ${cert.expires}` : ''}`
  };
}

const matches = (fields: (string | number | null)[], q: string): boolean => {
  const needle = q.trim().toLowerCase();
  return !needle || fields.some(f => f !== null && String(f).toLowerCase().includes(needle));
};

/** The Gateway servers search: name, port, protocol, TLS mode, Secret name and hosts. */
export function gatewayServerMatches(g: IngressGatewayServer, q: string): boolean {
  return matches([`${g.namespace}/${g.name}`, g.port, g.protocol, g.tlsMode, g.credentialName, ...g.hosts], q);
}

/** The Rejected before routing search: SNI or port. A row with no SNI matches "no SNI offered". */
export function rejectionMatches(r: IngressRejection, q: string): boolean {
  return matches([r.sni ?? 'no SNI offered', r.port], q);
}

/**
 * Where a Problems press naming an object lands on TLS & Listeners.
 *
 * srv's rows name a Certificate (`cert-expiry`), a PeerAuthentication (`permissive-mtls`) or a
 * credential Secret no Certificate manages (`join-gap`); `attentionProblems` passes the name and, when
 * the ref carries one, its namespace, so a same-named object in another namespace is never selected.
 * Certificates and PeerAuthentications get their row selected. A Secret narrows Gateway servers to
 * the servers naming it and selects the first. A name nothing holds returns `null`, so the landing
 * never filters a table down to "no match" for a problem the operator was just shown.
 */
export function listenersFocus(
  ingress: TrafficIngress | undefined,
  text: string | null | undefined,
  namespace?: string | null
): { table: 'certificates' | 'peerAuth' | 'servers'; key: string; serverSearch: string | null } | null {
  if (!ingress || !text) return null;
  const named = (o: { name: string; namespace: string }) => o.name === text && (!namespace || o.namespace === namespace);
  const cert = ingress.certificates?.items.find(named);
  if (cert) return { table: 'certificates', key: `${cert.namespace}/${cert.name}`, serverSearch: null };
  const pa = ingress.access?.peerAuthentications.find(named);
  if (pa) return { table: 'peerAuth', key: `${pa.namespace}/${pa.name}`, serverSearch: null };
  const server = ingress.gateways.find(g => gatewayServerMatches(g, text));
  return server ? { table: 'servers', key: server.key, serverSearch: text } : null;
}
