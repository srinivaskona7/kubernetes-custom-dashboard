/**
 * Matching a cluster's ConstraintTemplates against the upstream Gatekeeper policy library.
 *
 * The catalogue (gatekeeper-library.json) is reference data about open-policy-agent's published
 * templates — title, version, bundle membership and a fingerprint of the Rego — regenerated from
 * a checkout of github.com/open-policy-agent/gatekeeper-library by `npm run fleet:gk-library`.
 * It describes the library, never a cluster, so it is not a fixture: every row this module
 * produces is a join of a template the cluster returned against it.
 *
 * Three answers, and the difference between the last two is the point:
 *   - `custom`    the template's name is not in the library;
 *   - `library`   the name is, and its Rego matches the library line for line (each line trimmed);
 *   - `modified`  the name is, but the Rego differs — a fork carrying an upstream name, which is
 *                 exactly the template whose upstream title would otherwise be trusted wrongly.
 * `rego` is `null` rather than a guess when either side has no Rego to compare (a CEL-only
 * template), so a missing fingerprint never reads as "identical".
 */
import crypto from 'node:crypto';

import CATALOGUE from './gatekeeper-library.json' with { type: 'json' };
const BY_NAME = new Map(CATALOGUE.templates.map(t => [t.name, t]));

/** The two bundles the library publishes, in the order an operator tightens through them. */
const BUNDLES = ['pod-security-baseline', 'pod-security-restricted'];

/** Every Rego source a template carries: the legacy `targets[].rego` and `targets[].code[]` Rego. */
function regoSources(template) {
  const targets = (template && template.spec && Array.isArray(template.spec.targets)) ? template.spec.targets : [];
  const out = [];
  for (const t of targets) {
    if (t && typeof t.rego === 'string') out.push(t.rego);
    for (const c of (t && Array.isArray(t.code) ? t.code : [])) {
      if (c && c.engine === 'Rego' && c.source && typeof c.source.rego === 'string') out.push(c.source.rego);
    }
  }
  return out;
}

/** sha256 of the Rego with each line trimmed and blank lines dropped; `null` when there is none. */
function regoFingerprint(template) {
  const sources = regoSources(template);
  if (sources.length === 0) return null;
  const normalised = sources
    .map(s => s.split('\n').map(l => l.trim()).filter(Boolean).join('\n'))
    .join('\n---\n');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/** Compare dotted versions numerically; `null` when either is not a plain dotted number. */
function compareVersions(a, b) {
  const parse = v => (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The library verdict for one ConstraintTemplate the cluster returned. */
function libraryMatch(template) {
  const name = template && template.metadata && template.metadata.name;
  return matchEntry(name ? BY_NAME.get(name) || null : null, template);
}

/** `libraryMatch` against an explicit catalogue entry (or `null`), so the join is testable alone. */
function matchEntry(entry, template) {
  const annotations = (template && template.metadata && template.metadata.annotations) || {};
  const clusterVersion = annotations['metadata.gatekeeper.sh/version'] || null;
  if (!entry) {
    return { state: 'custom', title: null, libraryVersion: null, clusterVersion, behind: null, rego: null, bundles: [], path: null };
  }
  const fingerprint = regoFingerprint(template);
  const rego = fingerprint === null || entry.regoFingerprint === null
    ? null
    : fingerprint === entry.regoFingerprint ? 'identical' : 'differs';
  const cmp = compareVersions(clusterVersion, entry.version);
  return {
    state: rego === 'differs' ? 'modified' : 'library',
    title: entry.title,
    libraryVersion: entry.version,
    clusterVersion,
    // `true` only when both versions parse and the cluster's is lower; an unannotated template is `null`.
    behind: cmp === null ? null : cmp < 0,
    rego,
    bundles: entry.bundles,
    path: entry.path
  };
}

/**
 * Bundle coverage: for each library bundle, which of its templates this cluster has installed and
 * which it has a deny Constraint for. Membership is by library name only — a `modified` template
 * still counts as installed, and says so through its own row.
 *
 * @param {object[]} policies  OPA policy rows carrying `templateName`, `library`, `enforcementAction`, `status`
 */
function bundleCoverage(policies) {
  return BUNDLES.map(bundle => {
    const members = CATALOGUE.templates.filter(t => t.bundles.includes(bundle));
    const rows = members.map(t => {
      const own = policies.filter(p => p.templateName === t.name);
      // null when no row denies and one was unreadable (status 'unknown' = CONSTRAINTS_UNREADABLE),
      // so "does not deny" would be a guess. A template with no Constraint is 'inactive': a true no.
      const denies = own.some(p => p.enforcementAction === 'deny' && p.status === 'active');
      const enforcing = denies ? true : own.some(p => p.status === 'unknown') ? null : false;
      return {
        name: t.name,
        title: t.title,
        installed: own.length > 0,
        enforcing,
        modified: own.some(p => p.library && p.library.state === 'modified')
      };
    });
    return {
      bundle,
      total: rows.length,
      installed: rows.filter(r => r.installed).length,
      enforcing: rows.filter(r => r.enforcing === true).length,
      enforcingUnknown: rows.filter(r => r.enforcing === null).length,
      templates: rows
    };
  });
}

export default {
  CATALOGUE_SOURCE: CATALOGUE.source,
  BUNDLES,
  libraryMatch,
  matchEntry,
  bundleCoverage,
  regoFingerprint,
  compareVersions
};
