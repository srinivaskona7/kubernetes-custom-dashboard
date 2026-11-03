/**
 * The one decision Traffic Errors and Observability must not disagree about: did anything look?
 *
 * Each of the three states below is a different sentence on screen, and confusing any two of them
 * puts a confident `0` where the truth is "not read".
 */
import { describe, expect, it } from 'vitest';
import type { AccessLogProvider, AccessLogVerdict, TrafficWindow } from '../../api';
import { PROVIDER_KIND_WHY, accessLogEvidence } from './access-log';

function provider(over: Partial<AccessLogProvider> = {}): AccessLogProvider {
  return {
    name: 'stdout-json',
    kind: 'file',
    implementation: 'envoyFileAccessLog',
    readable: true,
    destination: '/dev/stdout',
    fields: null,
    ...over
  };
}

function verdict(over: Partial<AccessLogVerdict> = {}): AccessLogVerdict {
  return {
    state: 'on',
    reason: null,
    detail: null,
    providers: ['stdout-json'],
    decidedBy: [],
    providerDetail: [provider()],
    readable: true,
    unresolvedProviders: [],
    recordedElsewhere: false,
    meshUnavailable: false,
    why: '',
    ...over
  };
}

function window_(over: Partial<TrafficWindow> = {}): TrafficWindow {
  return {
    proxiesRead: 8,
    proxiesFailed: [],
    proxyCandidates: 10,
    proxiesSkipped: 2,
    tailLines: 400,
    namespace: null,
    sinceSeconds: null,
    linesRead: 3200,
    requestsParsed: 1964,
    linesUnparsed: 1236,
    truncatedProxies: 0,
    oldest: null,
    newest: null,
    readsSkipped: false,
    ...over
  };
}

describe('accessLogEvidence — the three states', () => {
  it('a stdout provider that returned requests is a real measurement', () => {
    const e = accessLogEvidence(verdict(), window_());
    expect(e.readsSkipped).toBe(false);
    expect(e.unprovenZero).toBe(false);
    expect(e.noEvidence).toBe(false);
  });

  it('lets a genuinely quiet stdout cluster keep its zero', () => {
    // readable === true is excluded from unprovenZero on purpose: the read could see the log,
    // and it saw nothing. That is a finding of "no traffic", not a failure to look.
    const e = accessLogEvidence(verdict(), window_({ requestsParsed: 0 }));
    expect(e.unprovenZero).toBe(false);
    expect(e.noEvidence).toBe(false);
  });

  it('calls an unconfirmable empty read unproven, never zero', () => {
    const e = accessLogEvidence(
      verdict({ readable: null, providerDetail: [provider({ kind: 'unresolved', implementation: null, readable: null, destination: null })] }),
      window_({ requestsParsed: 0 })
    );
    expect(e.unprovenZero).toBe(true);
    expect(e.noEvidence).toBe(true);
    expect(e.notRead.state).toBe('unavailable');
    expect(e.notRead.why).toBe('no request line came back, and the log destination could not be confirmed');
  });

  it('reports a skipped read as skipped even when the window parsed nothing', () => {
    const e = accessLogEvidence(
      verdict({ readable: false, recordedElsewhere: true, providers: ['kyma-logs'], providerDetail: [provider({ name: 'kyma-logs', kind: 'otlp', implementation: 'envoyOtelAls', readable: false, destination: 'telemetry-otlp-logs.kyma-system:4317', fields: 'otel' })] }),
      window_({ readsSkipped: true, proxiesRead: 0, requestsParsed: 0, linesRead: 0, linesUnparsed: 0 })
    );
    expect(e.readsSkipped).toBe(true);
    // Mutually exclusive: `unprovenZero` describes a read that happened.
    expect(e.unprovenZero).toBe(false);
    expect(e.noEvidence).toBe(true);
    expect(e.notRead.why).toBe('not read — kyma-logs streams off the pod');
  });

  it('names two off-pod sinks together, and falls back when none has a destination', () => {
    const two = accessLogEvidence(
      verdict({ readable: false, providerDetail: [provider({ name: 'kyma-logs', readable: false, destination: 'a:4317' }), provider({ name: 'otel-x', readable: false, destination: 'b:4317' })] }),
      window_({ readsSkipped: true })
    );
    expect(two.notRead.why).toBe('not read — kyma-logs and otel-x stream off the pod');

    // A tracing-only provider records nothing anywhere, so there is no destination to name.
    const none = accessLogEvidence(
      verdict({ readable: false, providerDetail: [provider({ name: 'tracing', kind: 'not-access-log', readable: false, destination: null })] }),
      window_({ readsSkipped: true })
    );
    expect(none.notRead.why).toBe('not read — nothing writes the access log to pod stdout');
  });
});

describe('accessLogEvidence — otelFields', () => {
  it('reads the vocabulary off the resolved provider, not off the rows', () => {
    expect(accessLogEvidence(verdict(), window_()).otelFields).toBe(false);
    expect(
      accessLogEvidence(verdict({ providerDetail: [provider({ fields: 'otel' })] }), window_()).otelFields
    ).toBe(true);
  });

  it('ignores otel fields on a provider this tab cannot read — its labels never arrive', () => {
    const e = accessLogEvidence(
      verdict({ readable: false, providerDetail: [provider({ readable: false, fields: 'otel', destination: 'x:4317' })] }),
      window_({ readsSkipped: true })
    );
    expect(e.otelFields).toBe(false);
  });
});

describe('accessLogEvidence — windowLine', () => {
  it('is empty with no window, so a loading tab states nothing', () => {
    expect(accessLogEvidence(undefined, undefined).windowLine).toBe('');
  });

  it('states the read, thousands-separated, singular at one request', () => {
    expect(accessLogEvidence(verdict(), window_()).windowLine).toBe(
      '1,964 requests from 8 of 10 proxies, 400 lines each'
    );
    expect(accessLogEvidence(verdict(), window_({ requestsParsed: 1 })).windowLine).toBe(
      '1 request from 8 of 10 proxies, 400 lines each'
    );
  });

  it('says why there is no window rather than printing an empty one', () => {
    expect(accessLogEvidence(verdict(), window_({ readsSkipped: true })).windowLine).toBe(
      'No window — none of 10 proxies were read, because the access log does not reach pod stdout'
    );
  });

  it('appends the span only when both ends are known', () => {
    const one = accessLogEvidence(verdict(), window_({ oldest: new Date().toISOString(), newest: null }));
    expect(one.windowLine).not.toContain('spanning');
    const both = accessLogEvidence(
      verdict(),
      window_({ oldest: new Date(Date.now() - 3_600_000).toISOString(), newest: new Date().toISOString() })
    );
    expect(both.windowLine).toContain('spanning');
  });
});

describe('PROVIDER_KIND_WHY', () => {
  it('explains every kind the payload can carry', () => {
    for (const kind of ['file', 'otlp', 'grpc', 'not-access-log', 'unknown', 'unresolved']) {
      expect(PROVIDER_KIND_WHY[kind], kind).toBeTruthy();
    }
  });
});
