/**
 * The release's access endpoint.
 *
 * The interesting half is what it refuses to do: no host means no endpoint, a wildcard means no
 * link, and the scheme is flagged as an assumption on every result. A pill that quietly invents an
 * address sends an operator to a hostname that resolves to nothing.
 */
import { describe, expect, it } from 'vitest';
import type { HelmRelatedResource } from '../../api';
import { endpointTitle, resolveAccessEndpoint } from './access-endpoint';

function resource(kind: string, name: string, facts: Record<string, unknown> = {}): HelmRelatedResource {
  return {
    id: `${kind}/app/${name}`,
    kind,
    name,
    namespace: 'app',
    group: 'Networking',
    relationship: 'helm-owned',
    evidence: 'test',
    status: null,
    createdAt: null,
    facts
  };
}

describe('resolveAccessEndpoint', () => {
  it('reads the first host an Ingress rule declares', () => {
    const e = resolveAccessEndpoint([resource('Ingress', 'app-web', { hosts: ['app.example.com'], backends: ['app-web'] })]);
    expect(e).toMatchObject({ host: 'app.example.com', source: 'spec.rules[].host', route: 'Ingress/app-web', url: 'https://app.example.com' });
  });

  it('reads an HTTPRoute hostname', () => {
    const e = resolveAccessEndpoint([resource('HTTPRoute', 'app-route', { hosts: ['route.example.com'] })]);
    expect(e).toMatchObject({ host: 'route.example.com', source: 'spec.hostnames', route: 'HTTPRoute/app-route' });
  });

  it('returns null when no route names a host', () => {
    expect(resolveAccessEndpoint([resource('Ingress', 'app-web', { hosts: [] })])).toBeNull();
    expect(resolveAccessEndpoint([resource('HTTPRoute', 'app-route', {})])).toBeNull();
    expect(resolveAccessEndpoint([resource('Service', 'app-web')])).toBeNull();
    expect(resolveAccessEndpoint([])).toBeNull();
  });

  it('ignores kinds that are not routes, even when they carry hosts', () => {
    // A VirtualService's `hosts` is often the in-mesh Service name, not an address anyone types.
    expect(resolveAccessEndpoint([resource('VirtualService', 'vs', { hosts: ['app.example.com'] })])).toBeNull();
  });

  it('codes defensively for a backend that sends no facts', () => {
    expect(resolveAccessEndpoint(undefined)).toBeNull();
    expect(resolveAccessEndpoint([{ ...resource('Ingress', 'r'), facts: undefined as never }])).toBeNull();
  });

  it('ignores a blank or whitespace-only host', () => {
    expect(resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['   '] })])).toBeNull();
    expect(resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['  ', 'real.example.com'] })])).toMatchObject({
      host: 'real.example.com'
    });
  });

  it('shows a wildcard host but does not link it', () => {
    const e = resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['*.example.com'] })]);
    expect(e).toMatchObject({ host: '*.example.com', url: null });
  });

  it('does not link a value that already carries a scheme or a path', () => {
    expect(resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['https://a.example.com'] })])?.url).toBeNull();
    expect(resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['a.example.com/api'] })])?.url).toBeNull();
  });

  it('links a host that carries an explicit port', () => {
    expect(resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['a.example.com:8443'] })])?.url).toBe(
      'https://a.example.com:8443'
    );
  });

  it('is deterministic across several routes, Ingress first then by name', () => {
    const routes = [
      resource('HTTPRoute', 'a-route', { hosts: ['h.example.com'] }),
      resource('Ingress', 'z-ing', { hosts: ['z.example.com'] }),
      resource('Ingress', 'm-ing', { hosts: ['m.example.com'] })
    ];
    expect(resolveAccessEndpoint(routes)?.host).toBe('m.example.com');
    expect(resolveAccessEndpoint([...routes].reverse())?.host).toBe('m.example.com');
    expect(resolveAccessEndpoint(routes)?.candidates).toBe(3);
    const routesOnly = routes.filter(r => r.kind === 'HTTPRoute');
    expect(resolveAccessEndpoint(routesOnly)?.host).toBe('h.example.com');
  });

  it('always marks the scheme as assumed', () => {
    expect(resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['a.example.com'] })])?.schemeAssumed).toBe(true);
  });
});

describe('endpointTitle', () => {
  it('names the field and the route, and says the scheme is a guess', () => {
    const e = resolveAccessEndpoint([resource('Ingress', 'app-web', { hosts: ['app.example.com'] })])!;
    const title = endpointTitle(e);
    expect(title).toContain('spec.rules[].host');
    expect(title).toContain('Ingress/app-web');
    expect(title).toContain('assumption');
  });

  it('explains a missing link instead of leaving it unexplained', () => {
    const e = resolveAccessEndpoint([resource('Ingress', 'r', { hosts: ['*.example.com'] })])!;
    expect(endpointTitle(e)).toContain('Not linked');
  });

  it('says how many routes declared a host when there is more than one', () => {
    const e = resolveAccessEndpoint([
      resource('Ingress', 'a', { hosts: ['a.example.com'] }),
      resource('HTTPRoute', 'b', { hosts: ['b.example.com'] })
    ])!;
    expect(endpointTitle(e)).toContain('2 routes');
  });
});
