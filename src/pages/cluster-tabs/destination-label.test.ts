/**
 * Traces → external destinations: the name a cluster object gives an address, and where it came from.
 */
import { describe, expect, it } from 'vitest';
import type { DestinationName, TraceNodeRef } from '../../api';
import { destinationLabel, destinationProvenance } from './destination-label';

const XSUAA: DestinationName = {
  display: 'Auth Service (OAuth) · us10',
  label: 'xsuaa-service-instances-us10',
  source: 'networkpolicy',
  key: 'xsuaa-service-instances-us10',
  qualifier: null,
  objects: ['NetworkPolicy acme-shop/egress-allow-saas-traffic'],
  others: []
};
const ref = (destination?: DestinationName): TraceNodeRef => ({ id: 'ext:3.214.110.153:443', kind: 'external', name: '3.214.110.153:443', namespace: null, ...(destination ? { destination } : {}) });

describe('destinationLabel', () => {
  it('shows the name first and keeps the address as the secondary line', () => {
    expect(destinationLabel(ref(XSUAA))).toEqual({ primary: 'Auth Service (OAuth) · us10', secondary: '3.214.110.153:443', named: true });
  });
  it('leaves an unnamed address bare, with nothing invented beside it', () => {
    expect(destinationLabel(ref())).toEqual({ primary: '3.214.110.153:443', secondary: null, named: false });
  });
});

describe('destinationProvenance', () => {
  it('names the object and the annotation key', () => {
    expect(destinationProvenance(XSUAA)).toBe('from NetworkPolicy acme-shop/egress-allow-saas-traffic annotation xsuaa-service-instances-us10');
  });
  it('names the policy and the ipBlock an egress rule allows', () => {
    const d: DestinationName = { ...XSUAA, display: 'Egress allowed by acme-shop/egress-hana', label: 'ipblock', source: 'networkpolicy-ipblock', key: null, objects: ['NetworkPolicy acme-shop/egress-hana'], namespace: 'acme-shop', policyName: 'egress-hana', cidr: '10.0.0.7/32' };
    expect(destinationProvenance(d)).toBe('from NetworkPolicy acme-shop/egress-hana egress ipBlock 10.0.0.7/32');
  });
  it('says a range name covers the address without repeating the CIDR', () => {
    const d: DestinationName = { ...XSUAA, display: 'Egress allowed by acme-shop/egress-hana', label: 'ipblock-range', source: 'networkpolicy-ipblock', key: null, qualifier: 'inside 10.0.0.0/24', objects: ['NetworkPolicy acme-shop/egress-hana'], cidr: '10.0.0.0/24' };
    expect(destinationProvenance(d)).toBe('from NetworkPolicy acme-shop/egress-hana egress ipBlock 10.0.0.0/24 (the address is inside it)');
  });
  it('counts the other names the same address was given', () => {
    const p = destinationProvenance({ ...XSUAA, others: ['Managed Postgres', 'Destination service'] });
    expect(p).toContain('+2 other names: Managed Postgres, Destination service');
  });
  it('says a load-balancer name came from the Service status, and how the hostname was resolved', () => {
    const p = destinationProvenance({
      display: "This cluster's ingress load balancer",
      label: 'ingress-lb',
      source: 'ingress-lb',
      key: null,
      qualifier: 'a1.elb.amazonaws.com by DNS at 2026-09-26T10:00:00.000Z',
      objects: ['Service istio-system/istio-ingressgateway']
    , others: [] });
    expect(p).toBe('from the load balancer status of Service istio-system/istio-ingressgateway (a1.elb.amazonaws.com by DNS at 2026-09-26T10:00:00.000Z)');
  });
  it('says a telemetry name is the pipelines’ export', () => {
    const p = destinationProvenance({ display: 'Cloud Logging (telemetry export)', label: 'Cloud Logging', source: 'telemetry', key: null, qualifier: null, objects: ['LogPipeline/cls', 'TracePipeline/cls'], others: [] });
    expect(p).toBe('from the telemetry export of LogPipeline/cls, TracePipeline/cls');
  });
  it('says a tied name is ambiguous and lists every claimant\'s object', () => {
    const objects = ['NetworkPolicy a/1', 'NetworkPolicy b/2', 'NetworkPolicy c/3', 'NetworkPolicy d/4'];
    const p = destinationProvenance({ ...XSUAA, display: 'API server A or API server B', key: null, ambiguous: true, objects });
    expect(p).toBe('from NetworkPolicy a/1, NetworkPolicy b/2, NetworkPolicy c/3, NetworkPolicy d/4 (ambiguous: policies of equal standing name this address differently)');
  });
  it('keeps a long object list short', () => {
    const objects = ['NetworkPolicy a/1', 'NetworkPolicy b/2', 'NetworkPolicy c/3', 'NetworkPolicy d/4', 'NetworkPolicy e/5'];
    expect(destinationProvenance({ ...XSUAA, objects })).toBe('from NetworkPolicy a/1, NetworkPolicy b/2, NetworkPolicy c/3 and 2 more annotation xsuaa-service-instances-us10');
  });
});
