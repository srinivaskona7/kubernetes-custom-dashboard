/**
 * How a failing request's source or destination is named. D1: an external peer arrives collapsed with
 * no address, so its label is a name and a count, never an empty address.
 */
import { describe, expect, test } from 'vitest';
import type { DestinationName, TrafficEndpoint } from '../../../api';
import { endpointHostName, endpointLabel, endpointName } from './endpoint-label';

const ep = (over: Partial<TrafficEndpoint>): TrafficEndpoint => ({ ip: '10.0.0.1', port: null, kind: 'Pod', name: 'apps/web-1', ...over }) as TrafficEndpoint;

describe('endpointLabel', () => {
  test('a claimed address reads as its object name', () => {
    expect(endpointLabel(ep({}))).toBe('apps/web-1');
  });

  test('an unclaimed address reads as the address', () => {
    expect(endpointLabel(ep({ kind: 'unresolved', ip: '100.96.1.2', name: '' }))).toBe('100.96.1.2');
  });

  test('the collapsed external row reads as its name and how many addresses it folds', () => {
    expect(endpointLabel(ep({ kind: 'external', ip: null, name: 'External clients', distinct: 115 }))).toBe('External clients (115 addresses)');
    expect(endpointLabel(ep({ kind: 'external', ip: null, name: 'External clients', distinct: 1 }))).toBe('External clients (1 address)');
  });

  test('without a distinct count it is the name alone, never an empty address', () => {
    expect(endpointLabel(ep({ kind: 'external', ip: null, name: 'External clients' }))).toBe('External clients');
  });
});

const CLS: DestinationName = {
  display: 'SAP Cloud Logging (telemetry export)',
  label: 'SAP Cloud Logging',
  source: 'telemetry',
  key: null,
  qualifier: null,
  objects: ['LogPipeline/cls-kyma-access-logs'],
  others: []
};
const LB: DestinationName = {
  display: "This cluster's ingress load balancer",
  label: 'ingress-lb',
  source: 'ingress-lb',
  key: null,
  qualifier: null,
  objects: ['Service istio-system/istio-ingressgateway'],
  others: []
};

describe('endpointName', () => {
  test('a named external upstream reads name first, address second, with where the name came from', () => {
    const named = endpointName(ep({ kind: 'external', ip: '3.225.140.11', name: '3.225.140.11', port: 443, destination: CLS }));
    expect(named).toEqual({ primary: 'SAP Cloud Logging (telemetry export)', secondary: '3.225.140.11:443', provenance: 'from the telemetry export of LogPipeline/cls-kyma-access-logs' });
  });

  test('an unnamed endpoint keeps its plain label and claims no provenance', () => {
    expect(endpointName(ep({}))).toEqual({ primary: 'apps/web-1', secondary: null, provenance: null });
    expect(endpointName(ep({ kind: 'external', ip: '8.8.8.8', name: '8.8.8.8' }))).toEqual({ primary: '8.8.8.8', secondary: null, provenance: null });
  });
});

describe('endpointHostName', () => {
  test('a bare-IP host the index names reads as the name, the IP beneath', () => {
    expect(endpointHostName({ host: '98.83.101.14', destination: LB })).toEqual({
      primary: "This cluster's ingress load balancer",
      secondary: '98.83.101.14',
      provenance: 'from the load balancer status of Service istio-system/istio-ingressgateway'
    });
  });

  test('an unnamed host stays the host; no host stays null', () => {
    expect(endpointHostName({ host: 'shop.example.com' })).toEqual({ primary: 'shop.example.com', secondary: null, provenance: null });
    expect(endpointHostName({ host: null })).toEqual({ primary: null, secondary: null, provenance: null });
  });
});
