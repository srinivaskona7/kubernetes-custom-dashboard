/**
 * The four-part explanations the page *shell* owns: the header, the two filter controls that are
 * routinely misread, the failures section, and the data-source footer.
 *
 * Separate from the component that renders them for the same reason `components/table/column-info.ts`
 * exists: a definition written inline at its call site is a second definition of a concept that
 * already has one, and the two drift. The metric tiles, the table's columns and the proxy views keep
 * their own content in their own modules — this file is deliberately only the shell's.
 *
 * Every entry keeps the three things apart that the request asks never to be blended: what the log
 * field *means*, what this dashboard *observed*, and what it *cannot determine*. `InfoPopover` renders
 * them as separate blocks with a rule between, so "limitations" cannot be skimmed past as the tail of
 * a sentence about what the number is.
 */
import type { InfoPopoverContent } from '../../../components/InfoPopover';

/**
 * The header's ⓘ. The one place on the page that states the ceiling of the whole data source before
 * the operator has read a single number from it.
 *
 * The last limitation is the important one and is worded as the request wrote it. "No errors found"
 * on this page is a statement about the lines that were read, and an operator who reads it as "the
 * mesh is healthy" has drawn a conclusion the data cannot support. That sentence is the guard.
 */
export const TRAFFIC_ERRORS_ABOUT: InfoPopoverContent = {
  title: 'About Traffic Errors',
  means:
    'This page reports traffic visible to the available Istio proxies. Traffic that is not captured or logged by a proxy may not appear here.',
  source: 'Istio / Envoy proxy access logs.',
  limitations: [
    'Workloads without proxy logging may not be represented.',
    'Traffic logged elsewhere may not appear.',
    'Failures occurring before a proxy receives a request may not appear.',
    'Absence of an observed error does not prove that all traffic is healthy.'
  ],
  sources: ['accessLog', 'telemetryApi', 'networkIssues']
};

/**
 * The namespace control's ⓘ, and the reason the control is labelled "Proxy namespace" rather than
 * "Namespace".
 *
 * A failure group has no namespace of its own — measured absent on all 430 groups of the live window.
 * The only namespace attached to a group is the one belonging to the proxy that wrote the log line,
 * which is a fact about *who reported the failure*, not about *whose traffic failed*. An operator who
 * reads a control labelled "Namespace" as "show me my team's traffic" gets an answer to a different
 * question with nothing on screen admitting it, so the label and this panel both say which namespace
 * is meant.
 */
export const PROXY_NAMESPACE_INFO: InfoPopoverContent = {
  title: 'Proxy namespace',
  means:
    'The namespace of the Istio proxy that logged the record — not the namespace the failing traffic belongs to. A failure group carries no namespace of its own. Selecting one or more here keeps the groups that at least one proxy in those namespaces reported.',
  source: 'proxies[].namespace on each failure group: where the access-log line was read from.',
  limitations: [
    'One group can be reported by proxies in several namespaces. It is kept when any of them matches, and its count still totals the records from every proxy that saw it.',
    'This narrows what is shown; it does not change which proxies were read. Proxies lists what was read.',
    'On a mesh where only the ingress gateways log, every proxy is in istio-system and this control has one option.'
  ],
  sources: ['accessLog']
};

/**
 * The time range's ⓘ.
 *
 * It has to say that the range is a request and not a guarantee. `sinceSeconds` genuinely reaches the
 * API server, but each proxy is also capped at a fixed line count, so "Last 7 days" reads the last
 * ≤1000 lines that fall inside seven days — which on a busy proxy is minutes. The page states the
 * window actually covered beside the control whenever the two differ materially; this panel says why
 * they can.
 */
export const TIME_RANGE_INFO: InfoPopoverContent = {
  title: 'Time range',
  means:
    'How far back each proxy is asked to go. This is the one control on the bar that changes what is read from the cluster rather than what is shown from a read already in hand.',
  source: 'sinceSeconds on GET /clusters/:id/traffic-errors, echoed back as window.sinceSeconds.',
  limitations: [
    'Each proxy is also capped at a fixed number of log lines, so a wide range reads the most recent lines that fall inside it rather than the whole range.',
    'The span actually covered is reported beside this control whenever it is materially shorter than the range selected. That span is the truth about what was read.',
    'There is no stored history behind this page. A range only decides how much of each proxy’s current log buffer is asked for.'
  ],
  sources: ['accessLog']
};

/**
 * The failures section's ⓘ.
 *
 * Two claims this panel exists to prevent: that a count is a rate, and that an empty table is a clean
 * mesh. It also states plainly that no trend is available, because the request asks for a TREND column
 * and there is no comparison period on the wire to compute one from.
 */
export const TRAFFIC_FAILURES_INFO: InfoPopoverContent = {
  title: 'Traffic failures',
  means:
    'One row per distinct failure shape — the same response code, method, host, path and upstream, however many times it occurred. The count is the number of matching records inside the window that was read.',
  source: 'Istio / Envoy proxy access logs, grouped by the collector before they reach the browser.',
  limitations: [
    'A count over a bounded tail of log lines. Never a rate, and never a total for the cluster.',
    'A failure appears only if a proxy logged it. A workload whose proxy does not log, or logs somewhere this console cannot read, contributes nothing to this table.',
    'No earlier window is kept, so no row can say whether a failure is becoming more or less frequent.'
  ],
  sources: ['accessLog', 'networkIssues']
};

/**
 * The footer's ⓘ. The provenance of the whole page in one place, for the reader who arrived at a
 * number first and wants to know where it came from second.
 *
 * It names the refused grant on purpose. "Why does this page show counts and not a percentage of
 * requests" is the question the shape of this data provokes, and the answer is a specific access
 * decision rather than an oversight.
 */
export const DATA_SOURCE_INFO: InfoPopoverContent = {
  title: 'Data source',
  means:
    'Everything on this page is parsed from Istio / Envoy proxy access logs, read as a bounded tail from the istio-proxy container of a bounded number of pods.',
  source: 'The Kubernetes pods/log subresource, on pods that carry an istio-proxy container.',
  limitations: [
    'Nothing is stored or indexed here. What is shown is the tail the node still holds at the moment of the read.',
    'Istio’s own request totals live in the istio_requests_total metric, which this console is not granted the access needed to scrape. That is why it reports counts and never rates.',
    'Absence of an observed error does not prove that all traffic is healthy.'
  ],
  sources: ['accessLog', 'telemetryApi', 'networkIssues']
};
