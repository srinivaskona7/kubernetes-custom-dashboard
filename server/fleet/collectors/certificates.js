/**
 * Certificate & TLS expiry collector.
 *
 * Scans certificates and Ingress TLS secrets metadata across the fleet, computing real-time
 * expiration countdowns and alerting on imminent expiries (< 14 days).
 *
 * Two certificate providers, read side by side, never either-or. cert-manager.io/v1 is what
 * this file originally read; on a Gardener-managed Kyma cluster that CRD is genuinely absent
 * — Gardener mints and rotates its own `cert.gardener.cloud/v1alpha1` Certificates instead —
 * so reading only cert-manager.io reported "0 certificates" over 4 real, live, healthy
 * certificates on the cluster this fix was verified against. A different customer cluster
 * may run cert-manager, Gardener's provider, both, or neither, so both reads happen on every
 * collection and both feed the SAME `certificates` summary label — see `providers` below.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;
import fanoutModule from '../fanout.js';
const { publicCluster } = fanoutModule;

const CERT_MANAGER_PATH = '/apis/cert-manager.io/v1/certificates';
const GARDENER_CERT_PATH = '/apis/cert.gardener.cloud/v1alpha1/certificates';

/** Both providers expose a Ready-style condition; this is the one mapping either uses. */
function readyFromConditions(conditions) {
  const readyCondition = (conditions || []).find(cond => cond.type === 'Ready');
  return readyCondition ? readyCondition.status === 'True' : true;
}

/**
 * cert-manager.io/v1 Certificate -> the common shape below. `status.notAfter` /
 * `status.renewalTime` are this provider's own field names, already matching the output
 * field names, so no renaming happens on this branch.
 */
function fromCertManager(c, ctx) {
  const meta = c.metadata || {};
  const spec = c.spec || {};
  const status = c.status || {};
  return {
    provider: 'cert-manager.io',
    id: `${ctx.cluster.id}:${meta.namespace}/${meta.name}`,
    clusterId: ctx.cluster.id,
    name: meta.name,
    namespace: meta.namespace,
    dnsNames: spec.dnsNames || [],
    secretName: spec.secretName || meta.name,
    issuerRef: spec.issuerRef ? `${spec.issuerRef.kind}/${spec.issuerRef.name}` : 'Unknown',
    notAfter: status.notAfter || null,
    isReady: readyFromConditions(status.conditions),
    renewalTime: status.renewalTime || null
  };
}

/**
 * cert.gardener.cloud/v1alpha1 Certificate -> the common shape above. Field names diverge
 * from cert-manager's and must be mapped, not just renamed 1:1 through the same accessor:
 * `status.expirationDate` is this provider's `notAfter`, `status.renewalDate` is its
 * `renewalTime` (Gardener certificates do carry a renewal-time equivalent — confirmed on
 * the real object shape rather than assumed absent). `status.message` on a Ready object
 * reads as ordinary informational text on this cluster's real objects — e.g. "certificate
 * (SN ...) valid from ..." — so it is deliberately NOT piped into any error/detail field;
 * doing so would misrepresent a healthy certificate as having a problem. `status.state` is
 * not special-cased: the existing Ready-condition mapping (`readyFromConditions`) already
 * covers both providers' real objects, and adding a second branch for `state` would be an
 * unnecessary fork with no object observed where the two disagree.
 */
function fromGardener(c, ctx) {
  const meta = c.metadata || {};
  const spec = c.spec || {};
  const status = c.status || {};
  return {
    provider: 'cert.gardener.cloud',
    id: `${ctx.cluster.id}:${meta.namespace}/${meta.name}`,
    clusterId: ctx.cluster.id,
    name: meta.name,
    namespace: meta.namespace,
    dnsNames: spec.dnsNames || spec.commonName ? [spec.commonName, ...(spec.dnsNames || [])].filter(Boolean) : [],
    secretName: (spec.secretRef && spec.secretRef.name) || meta.name,
    issuerRef: spec.issuerRef ? `${spec.issuerRef.kind || 'Issuer'}/${spec.issuerRef.name}` : 'Unknown',
    notAfter: status.expirationDate || null,
    isReady: readyFromConditions(status.conditions),
    renewalTime: status.renewalDate || null
  };
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list}} ctx
 */
async function collect(ctx) {
  const listFn = ctx.listFn || list;

  const [certManagerResult, gardenerResult, ingressesResult] = await Promise.all([
    safeList(listFn, ctx, CERT_MANAGER_PATH, 'certificates'),
    safeList(listFn, ctx, GARDENER_CERT_PATH, 'certificates'),
    safeList(listFn, ctx, '/apis/networking.k8s.io/v1/ingresses', 'ingress-tls')
  ]);

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const certificates = [
    ...certManagerResult.items.map(c => fromCertManager(c, ctx)),
    ...gardenerResult.items.map(c => fromGardener(c, ctx))
  ].map(cert => {
    let daysRemaining = null;
    let isExpiringSoon = false;
    let isExpired = false;
    if (cert.notAfter) {
      const expiryMs = new Date(cert.notAfter).getTime();
      daysRemaining = Math.floor((expiryMs - now) / DAY_MS);
      isExpiringSoon = daysRemaining <= 14 && daysRemaining >= 0;
      isExpired = daysRemaining < 0;
    }
    return { ...cert, daysRemaining, isExpiringSoon, isExpired };
  });

  // Also extract TLS secret bindings from Ingresses, useful whether or not either
  // certificate provider is installed.
  const ingressTls = ingressesResult.items.flatMap(ing => {
    const meta = ing.metadata || {};
    const spec = ing.spec || {};
    return (spec.tls || []).map(t => ({
      ingressName: meta.name,
      namespace: meta.namespace,
      hosts: t.hosts || [],
      secretName: t.secretName || '—'
    }));
  });

  // Both reads share the ONE 'certificates' label so either provider flipping to
  // unavailable degrades the single downstream tile — no per-provider UI branch needed.
  // Only a provider that actually answered (whether with items or a confirmed empty list)
  // counts as having contributed data; a 403/timeout contributes nothing even if the other
  // provider is fine.
  const providers = [
    !certManagerResult.unavailable ? 'cert-manager.io' : null,
    !gardenerResult.unavailable ? 'cert.gardener.cloud' : null
  ].filter(Boolean);
  const bothProvidersUnavailable = certManagerResult.unavailable && gardenerResult.unavailable;

  return {
    cluster: publicCluster(ctx.cluster),
    summary: {
      // null only when NEITHER provider answered — one live provider is still a real count.
      totalCertificates: bothProvidersUnavailable ? null : certificates.length,
      expiringSoon: certificates.filter(c => c.isExpiringSoon).length,
      expired: certificates.filter(c => c.isExpired).length,
      unready: certificates.filter(c => !c.isReady).length,
      providers,
      // null when the Ingress read itself was refused, for exactly the reason `totalCertificates`
      // above is: `ingressTls` degrades to `[]` on a 403, and `[].length` is a confident 0 that
      // says "nothing on this cluster terminates TLS at an Ingress" — the opposite of "we were
      // not allowed to look". The number has to carry that distinction itself, because /report,
      // an export and the fleet-wide route all read it without consulting `unavailable`.
      totalIngressTlsHosts: ingressesResult.unavailable ? null : ingressTls.flatMap(t => t.hosts).length,
      // 'certificates' appears at most once even though two reads share the label — a
      // duplicate entry would tell the UI nothing an operator can act on twice.
      unavailable: [...new Set(unavailableLabels([certManagerResult, gardenerResult, ingressesResult]))],
      // Reads that answered but stopped at the client's paging ceiling. `expiringSoon` and
      // `expired` are floors on an alarm rather than on an inventory: the certificate about to
      // lapse may be one of the ones past the cut, so a reassuring 0 here is not reassurance.
      truncated: [...new Set(truncatedLabels([certManagerResult, gardenerResult, ingressesResult]))]
    },
    certificates,
    ingressTls
  };
}

export default { collect };
