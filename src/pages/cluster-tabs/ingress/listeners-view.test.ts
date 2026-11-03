/**
 * TLS & Listeners rows. The PeerAuthentication row, the Gateway server's expiry cell and the two
 * table searches each make a claim an operator reads as fact, so each gets a test.
 */
import { describe, expect, test } from 'vitest';
import type { IngressCertificate, IngressGatewayServer, IngressRejection, TrafficIngress } from '../../../api';
import { gatewayServerMatches, listenersFocus, peerAuthRow, rejectionMatches, serverExpiry, tlsTone } from './listeners-view';

const server = (over: Partial<IngressGatewayServer> = {}): IngressGatewayServer => ({
  key: 'platform-system/main-gateway/0',
  name: 'main-gateway',
  namespace: 'platform-system',
  selector: { istio: 'ingressgateway' },
  port: 443,
  portName: 'https',
  protocol: 'HTTPS',
  tlsMode: 'SIMPLE',
  credentialName: 'main-gateway-certs',
  minProtocolVersion: null,
  httpsRedirect: false,
  hosts: ['*.c-9d0a141.apps.example.com'],
  ...over
});

const cert = (over: Partial<IngressCertificate> = {}): IngressCertificate => ({
  namespace: 'istio-system',
  name: 'main-gateway-certs',
  secretName: 'main-gateway-certs',
  commonName: null,
  dnsNames: ['*.c-9d0a141.apps.example.com'],
  expires: '2026-12-01T00:00:00Z',
  daysLeft: 66,
  ready: true,
  issuer: 'garden',
  usedBy: [],
  ...over
});

describe('peerAuthRow', () => {
  test('a selector-less PeerAuthentication applies to its whole namespace', () => {
    const row = peerAuthRow({ namespace: 'istio-system', name: 'default', mode: 'STRICT', selector: null });
    expect(row).toMatchObject({ key: 'istio-system/default', name: 'istio-system/default', mode: 'STRICT', tone: 'ok', scope: 'namespace-wide' });
    expect(peerAuthRow({ namespace: 'a', name: 'b', mode: 'STRICT', selector: {} }).scope).toBe('namespace-wide');
  });

  test('a selector reads as its labels, in the order the object declares them', () => {
    expect(peerAuthRow({ namespace: 'a', name: 'b', mode: 'PERMISSIVE', selector: { app: 'web', tier: 'fe' } }).scope).toBe('app=web, tier=fe');
  });

  test('PERMISSIVE and DISABLE are amber, STRICT green, anything else unknown and never green', () => {
    expect(peerAuthRow({ namespace: 'a', name: 'b', mode: 'PERMISSIVE', selector: null }).tone).toBe('warn');
    expect(peerAuthRow({ namespace: 'a', name: 'b', mode: 'DISABLE', selector: null }).tone).toBe('warn');
    expect(peerAuthRow({ namespace: 'a', name: 'b', mode: 'UNSET', selector: null }).tone).toBe('unknown');
  });

  test('no mode is "unset", inheriting, not a guessed default', () => {
    const row = peerAuthRow({ namespace: 'a', name: 'b', mode: null, selector: null });
    expect(row.mode).toBe('unset');
    expect(row.tone).toBe('unknown');
    expect(row.why).toMatch(/mesh default/);
  });
});

describe('tlsTone', () => {
  test('violet is never a TLS verdict: an unrecognised mode is unknown', () => {
    expect(tlsTone('PASSTHROUGH')).toBe('unknown');
    expect(tlsTone('AUTO_PASSTHROUGH')).toBe('unknown');
    expect(tlsTone(null)).toBe('unknown');
    expect(tlsTone('SIMPLE')).toBe('ok');
    expect(tlsTone('DISABLE')).toBe('warn');
  });
});

describe('serverExpiry', () => {
  const certs = { items: [cert()], unavailable: false, reason: null };

  test('a server that names no credential has no expiry to show', () => {
    expect(serverExpiry(server({ credentialName: null }), certs)).toMatchObject({ text: '—', tone: null });
  });

  test('an unread Certificates list is unknown, never "no Certificate"', () => {
    expect(serverExpiry(server(), { items: [], unavailable: true, reason: 'forbidden' })).toMatchObject({ text: 'not read', tone: 'unknown' });
    expect(serverExpiry(server(), undefined)).toMatchObject({ text: 'not read', tone: 'unknown' });
  });

  test('a Secret with no Certificate says so, as unknown', () => {
    expect(serverExpiry(server({ credentialName: 'other' }), certs)).toMatchObject({ text: 'no Certificate found', tone: 'unknown' });
  });

  test('a found Certificate carries its days left and tone', () => {
    expect(serverExpiry(server(), certs)).toMatchObject({ text: '66 d left', tone: 'ok' });
    expect(serverExpiry(server(), { ...certs, items: [cert({ daysLeft: 45, renewalOverdue: true })] }).tone).toBe('warn');
    expect(serverExpiry(server(), { ...certs, items: [cert({ daysLeft: 45, renewalOverdue: false })] }).tone).toBe('ok');
    expect(serverExpiry(server(), { ...certs, items: [cert({ ready: false })] })).toMatchObject({ text: 'not Ready', tone: 'bad' });
  });

  test('sorts on days left, never on the text ("100 d left" is later than "50 d left")', () => {
    const days = (d: number) => serverExpiry(server(), { ...certs, items: [cert({ daysLeft: d })] }).daysLeft;
    expect(days(100)).toBe(100);
    expect(days(100)! > days(50)!).toBe(true);
    expect(serverExpiry(server({ credentialName: null }), certs).daysLeft).toBeNull();
    expect(serverExpiry(server(), undefined).daysLeft).toBeNull();
  });
});

describe('table searches', () => {
  test('a Gateway server matches on its name, port, protocol, mode, Secret name and hosts', () => {
    const g = server();
    for (const q of ['platform-system/main', '443', 'https', 'simple', 'gateway-certs', 'apps.example', '']) {
      expect(gatewayServerMatches(g, q), q).toBe(true);
    }
    expect(gatewayServerMatches(g, 'nothing-like-it')).toBe(false);
  });

  test('a rejection matches on its SNI or port, and "no SNI" finds the SNI-less row', () => {
    const r: IngressRejection = { key: 'k', sni: null, port: 443, count: 260, clients: 40, firstSeen: null, lastSeen: null };
    expect(rejectionMatches(r, 'no sni')).toBe(true);
    expect(rejectionMatches(r, '443')).toBe(true);
    expect(rejectionMatches({ ...r, sni: 'api.example.com' }, 'EXAMPLE')).toBe(true);
    expect(rejectionMatches({ ...r, sni: 'api.example.com' }, 'no sni')).toBe(false);
  });
});

describe('listenersFocus', () => {
  const ingress = {
    gateways: [server()],
    certificates: { items: [cert({ name: 'edge-cert' })], unavailable: false, reason: null },
    access: {
      peerAuthentications: [{ namespace: 'istio-system', name: 'default', mode: 'PERMISSIVE', selector: null }]
    }
  } as unknown as TrafficIngress;

  test('a Certificate problem selects its row in Certificates', () => {
    expect(listenersFocus(ingress, 'edge-cert')).toEqual({ table: 'certificates', key: 'istio-system/edge-cert', serverSearch: null });
  });

  test('a PeerAuthentication problem selects its row in Mesh mTLS', () => {
    expect(listenersFocus(ingress, 'default')).toEqual({ table: 'peerAuth', key: 'istio-system/default', serverSearch: null });
  });

  test('a namespaced PeerAuthentication problem selects that namespace\'s row', () => {
    const two = {
      ...ingress,
      access: {
        peerAuthentications: [
          { namespace: 'app', name: 'default', mode: 'STRICT', selector: null },
          { namespace: 'shop', name: 'default', mode: 'PERMISSIVE', selector: null }
        ]
      }
    } as unknown as TrafficIngress;
    expect(listenersFocus(two, 'default', 'shop')).toEqual({ table: 'peerAuth', key: 'shop/default', serverSearch: null });
  });

  test('a Secret name narrows Gateway servers to the servers that name it, and selects the first', () => {
    expect(listenersFocus(ingress, 'main-gateway-certs')).toEqual({ table: 'servers', key: 'platform-system/main-gateway/0', serverSearch: 'main-gateway-certs' });
  });

  test('a name nothing holds leaves every table unfiltered, never an empty one', () => {
    expect(listenersFocus(ingress, 'gone')).toBeNull();
    expect(listenersFocus(ingress, null)).toBeNull();
    expect(listenersFocus(undefined, 'edge-cert')).toBeNull();
  });
});
