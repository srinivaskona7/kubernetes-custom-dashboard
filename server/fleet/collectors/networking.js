/**
 * Networking collector: Ingresses, Gateway API Gateways and HTTPRoutes, Istio VirtualServices
 * and Gateways, and Services.
 *
 * Provides a single unified view of how services are exposed, their TLS status,
 * gateways, and host routing across the fleet.
 *
 * ## What is required and what is optional
 *
 * `networking.k8s.io/v1` Ingress and `v1` Service are served by every conformant cluster.
 * Gateway API (`gateway.networking.k8s.io/v1`) and Istio (`networking.istio.io/v1`) are CRDs a
 * cluster may simply not have, and safe-list.js already reads a 404 on them as "not installed":
 * their counts are an honest zero, never an entry in `summary.unavailable`. A 403 or a timeout
 * on any of them is still unavailable — a denial is not an absence.
 */
import k8sModule from '../k8s.js';
const { list, namespaceSegment } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;

/** The Gateway API group and the version this collector reads. Constants, never request input. */
const GATEWAY_API = 'gateway.networking.k8s.io/v1';

/** Istio's networking group; `v1` is served from Istio 1.22 on. */
const ISTIO_NETWORKING = 'networking.istio.io/v1';

/** A Gateway API condition of `type`, read as a boolean; `null` when the controller has not said. */
function conditionTrue(obj, type) {
  const c = (((obj || {}).status || {}).conditions || []).find(x => x && x.type === type);
  return c ? c.status === 'True' : null;
}

/** One Gateway API Gateway: its class, its listeners, and whether its controller programmed it. */
function parseGateway(gw) {
  const spec = gw.spec || {};
  return {
    id: `${gw.metadata.namespace}/${gw.metadata.name}`,
    name: gw.metadata.name,
    namespace: gw.metadata.namespace,
    gatewayClassName: spec.gatewayClassName || null,
    listeners: (spec.listeners || []).map(l => ({
      name: l.name || null,
      protocol: l.protocol || null,
      port: l.port || null,
      hostname: l.hostname || null,
      tls: !!(l.tls && (l.tls.certificateRefs || []).length)
    })),
    programmed: conditionTrue(gw, 'Programmed'),
    createdAt: gw.metadata.creationTimestamp || null
  };
}

/**
 * One HTTPRoute. A `parentRef` or `backendRef` without a namespace means the route's own, per
 * the Gateway API spec, so it is filled in here rather than left for the reader to guess.
 */
function parseHttpRoute(route) {
  const spec = route.spec || {};
  const ns = route.metadata.namespace;
  return {
    id: `${ns}/${route.metadata.name}`,
    name: route.metadata.name,
    namespace: ns,
    hostnames: spec.hostnames || [],
    parents: (spec.parentRefs || []).map(p => `${p.namespace || ns}/${p.name}`),
    backends: (spec.rules || []).flatMap(r =>
      (r.backendRefs || []).map(b => ({
        name: b.name,
        namespace: b.namespace || ns,
        port: b.port || null,
        weight: typeof b.weight === 'number' ? b.weight : 1
      }))
    ),
    accepted: (((route.status || {}).parents) || []).length
      ? route.status.parents.every(p => (p.conditions || []).some(c => c.type === 'Accepted' && c.status === 'True'))
      : null,
    createdAt: route.metadata.creationTimestamp || null
  };
}

/**
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, namespace, listFn = list }) {
  const nsQuery = namespaceSegment(namespace);
  const baseCtx = { cluster, token };

  const [ingresses, gateways, httproutes, virtualservices, istioGateways, services] = await Promise.all([
    safeList(listFn, baseCtx, `/apis/networking.k8s.io/v1/${nsQuery}ingresses`, 'ingresses'),
    safeList(listFn, baseCtx, `/apis/${GATEWAY_API}/${nsQuery}gateways`, 'gateways'),
    safeList(listFn, baseCtx, `/apis/${GATEWAY_API}/${nsQuery}httproutes`, 'httproutes'),
    safeList(listFn, baseCtx, `/apis/${ISTIO_NETWORKING}/${nsQuery}virtualservices`, 'virtualservices'),
    safeList(listFn, baseCtx, `/apis/${ISTIO_NETWORKING}/${nsQuery}gateways`, 'istio-gateways'),
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}services`, 'services')
  ]);
  const reads = [ingresses, gateways, httproutes, virtualservices, istioGateways, services];

  // Parse Gateway API Gateways and HTTPRoutes
  const gatewayItems = gateways.items.map(parseGateway);
  const httprouteItems = httproutes.items.map(parseHttpRoute);

  // Parse Istio VirtualServices
  const vsItems = virtualservices.items.map(vs => {
    const spec = vs.spec || {};
    const hosts = spec.hosts || [];
    const httpRules = (spec.http || []).flatMap(h =>
      (h.route || []).map(r => ({
        destinationHost: (r.destination && r.destination.host) || '',
        destinationPort: (r.destination && r.destination.port && r.destination.port.number) || null,
        weight: r.weight || 100
      }))
    );

    return {
      id: `${vs.metadata.namespace}/${vs.metadata.name}`,
      name: vs.metadata.name,
      namespace: vs.metadata.namespace,
      hosts,
      gateways: spec.gateways || [],
      routes: httpRules,
      createdAt: vs.metadata.creationTimestamp || null
    };
  });

  // Parse Ingresses
  const ingressItems = ingresses.items.map(ing => {
    const spec = ing.spec || {};
    const rules = (spec.rules || []).map(r => ({
      host: r.host || '*',
      paths: ((r.http && r.http.paths) || []).map(p => ({
        path: p.path || '/',
        pathType: p.pathType || 'ImplementationSpecific',
        backendService: (p.backend && p.backend.service && p.backend.service.name) || ''
      }))
    }));
    const tls = (spec.tls || []).map(t => ({
      hosts: t.hosts || [],
      secretName: t.secretName || null
    }));

    return {
      id: `${ing.metadata.namespace}/${ing.metadata.name}`,
      name: ing.metadata.name,
      namespace: ing.metadata.namespace,
      rules,
      tls,
      ingressClassName: spec.ingressClassName || null,
      createdAt: ing.metadata.creationTimestamp || null
    };
  });

  // Parse Services overview
  const serviceItems = services.items.map(svc => {
    const spec = svc.spec || {};
    return {
      name: svc.metadata.name,
      namespace: svc.metadata.namespace,
      type: spec.type || 'ClusterIP',
      clusterIP: spec.clusterIP || null,
      ports: (spec.ports || []).map(p => ({
        name: p.name || null,
        port: p.port,
        targetPort: p.targetPort,
        protocol: p.protocol || 'TCP'
      })),
      createdAt: svc.metadata.creationTimestamp || null
    };
  });

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      ingressesCount: ingressItems.length,
      /** Gateway API Gateways. Istio's own Gateway CR is counted separately below. */
      gatewaysCount: gatewayItems.length,
      httproutesCount: httprouteItems.length,
      virtualServicesCount: vsItems.length,
      istioGatewaysCount: istioGateways.items.length,
      servicesCount: serviceItems.length,
      /**
       * Labels of the reads that could not be performed. Non-empty means the counts above
       * are floors, not totals — a 403 is not a zero.
       */
      unavailable: unavailableLabels(reads),
      /**
       * Labels of the reads that answered but stopped at the client's paging ceiling. Distinct
       * from `unavailable` in the direction of the error: the items behind a truncated read
       * are real, so the exposure this page describes is understated rather than fabricated —
       * a host that is not listed here may still be routing.
       */
      truncated: truncatedLabels(reads)
    },
    ingresses: ingressItems,
    gateways: gatewayItems,
    httproutes: httprouteItems,
    virtualservices: vsItems,
    services: serviceItems,
    collectedAt: new Date().toISOString()
  };
}

export default { collect };
