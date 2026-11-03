/**
 * LabelSelector evaluation (matchLabels + matchExpressions), generic label-map-vs-selector.
 *
 * Shared rather than re-implemented so security.js's NetworkPolicy coverage and
 * helm-related.js's PDB / NetworkPolicy joins cannot disagree about which pods a selector
 * actually picks up.
 */

function matchesExpression(labels, expr) {
  const key = expr && expr.key;
  const op = expr && expr.operator;
  if (!key || !op) return false;
  const has = Object.prototype.hasOwnProperty.call(labels, key);
  const values = Array.isArray(expr.values) ? expr.values : [];
  switch (op) {
    case 'In': return has && values.includes(labels[key]);
    case 'NotIn': return !has || !values.includes(labels[key]);
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
    default: return false;
  }
}

/** An absent selector, or one with neither field set, selects everything — LabelSelector semantics. */
function selectorMatches(labels, selector) {
  const safeLabels = labels || {};
  if (!selector) return true;
  const matchLabels = selector.matchLabels || null;
  const matchExpressions = Array.isArray(selector.matchExpressions) ? selector.matchExpressions : null;
  if (!matchLabels && !matchExpressions) return true;
  if (matchLabels && !Object.entries(matchLabels).every(([k, v]) => safeLabels[k] === v)) return false;
  if (matchExpressions && !matchExpressions.every(expr => matchesExpression(safeLabels, expr))) return false;
  return true;
}

export default { selectorMatches };
