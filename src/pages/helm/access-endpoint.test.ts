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
  it('prefers the forwarded host, which is the name an operator types', () => {
    const e = resolveAccessEndpoint([
      resource('APIRule', 'app-api', { forwardedHost: 'app.example.com', hosts: ['app-approuter.app.svc.cluster.local'] })
    ]);
    expect(e).toMatchObject({ host: 'app.example.com', source: 'x-forwarded-host', url: 'https://app.example.com' });
  });

  it('falls back to the first declared host', () => {
    const e = resolveAccessEndpoint([resource('APIRule', 'app-api', { hosts: ['declared.example.com'] })]);
    expect(e).toMatchObject({ host: 'declared.example.com', source: 'spec.hosts' });
  });

  it('returns null when no APIRule names a host', () => {
    expect(resolveAccessEndpoint([resource('APIRule', 'app-api', { hosts: [] })])).toBeNull();
    expect(resolveAccessEndpoint([resource('APIRule', 'app-api', {})])).toBeNull();
    expect(resolveAccessEndpoint([resource('Service', 'app-approuter')])).toBeNull();
    expect(resolveAccessEndpoint([])).toBeNull();
  });

  it('codes defensively for a backend that sends neither field', () => {
    // The wire gained forwardedHost/hosts after this UI shipped; an older server must not crash it.
    expect(resolveAccessEndpoint(undefined)).toBeNull();
    expect(resolveAccessEndpoint([{ ...resource('APIRule', 'r'), facts: undefined as never }])).toBeNull();
  });

  it('ignores a blank or whitespace-only host', () => {
    expect(resolveAccessEndpoint([resource('APIRule', 'r', { forwardedHost: '   ' })])).toBeNull();
    expect(resolveAccessEndpoint([resource('APIRule', 'r', { forwardedHost: '', hosts: ['  ', 'real.example.com'] })]))
      .toMatchObject({ host: 'real.example.com', source: 'spec.hosts' });
  });

  it('shows a wildcard host but does not link it', () => {
    const e = resolveAccessEndpoint([resource('APIRule', 'r', { hosts: ['*.example.com'] })]);
    expect(e).toMatchObject({ host: '*.example.com', url: null });
  });

  it('does not link a value that already carries a scheme or a path', () => {
    expect(resolveAccessEndpoint([resource('APIRule', 'r', { hosts: ['https://a.example.com'] })])?.url).toBeNull();
    expect(resolveAccessEndpoint([resource('APIRule', 'r', { hosts: ['a.example.com/api'] })])?.url).toBeNull();
  });

  it('links a host that carries an explicit port', () => {
    expect(resolveAccessEndpoint([resource('APIRule', 'r', { hosts: ['a.example.com:8443'] })])?.url).toBe(
      'https://a.example.com:8443'
    );
  });

  it('is deterministic across several APIRules, forwarded host first then by name', () => {
    const rules = [
      resource('APIRule', 'z-rule', { hosts: ['z.example.com'] }),
      resource('APIRule', 'a-rule', { hosts: ['a.example.com'] }),
      resource('APIRule', 'm-rule', { forwardedHost: 'm.example.com' })
    ];
    expect(resolveAccessEndpoint(rules)?.host).toBe('m.example.com');
    expect(resolveAccessEndpoint([...rules].reverse())?.host).toBe('m.example.com');
    expect(resolveAccessEndpoint(rules)?.candidates).toBe(3);
    const declaredOnly = rules.filter(r => r.name !== 'm-rule');
    expect(resolveAccessEndpoint(declaredOnly)?.host).toBe('a.example.com');
  });

  it('always marks the scheme as assumed', () => {
    expect(resolveAccessEndpoint([resource('APIRule', 'r', { hosts: ['a.example.com'] })])?.schemeAssumed).toBe(true);
  });
});

describe('endpointTitle', () => {
  it('names the field and the APIRule, and says the scheme is a guess', () => {
    const e = resolveAccessEndpoint([resource('APIRule', 'app-api', { forwardedHost: 'app.example.com' })])!;
    const title = endpointTitle(e);
    expect(title).toContain('x-forwarded-host');
    expect(title).toContain('APIRule/app-api');
    expect(title).toContain('assumption');
  });

  it('explains a missing link instead of leaving it unexplained', () => {
    const e = resolveAccessEndpoint([resource('APIRule', 'r', { hosts: ['*.example.com'] })])!;
    expect(endpointTitle(e)).toContain('Not linked');
  });

  it('says how many APIRules declared a host when there is more than one', () => {
    const e = resolveAccessEndpoint([
      resource('APIRule', 'a', { hosts: ['a.example.com'] }),
      resource('APIRule', 'b', { hosts: ['b.example.com'] })
    ])!;
    expect(endpointTitle(e)).toContain('2 APIRules');
  });
});
