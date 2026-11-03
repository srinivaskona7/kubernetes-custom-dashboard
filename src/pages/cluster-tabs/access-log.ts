/**
 * What the access-log read is worth, as one decision two tabs share.
 *
 * Traffic Errors and Observability read the *same* payload — one bounded tail from up to ten
 * `istio-proxy` containers, one cache entry — and both have to answer the same question before
 * they render a single number: **did anything actually look?** Getting that answer subtly
 * different on the two tabs would be worse than getting it wrong on one, because the two would
 * then disagree about the same window: "0 server errors" on one screen and "requests unavailable"
 * on the other, from one read.
 *
 * So the three states live here, once:
 *
 *   - **`readsSkipped`** — the server did not tail any proxy, because it proved the mesh sends the
 *     access log somewhere pod stdout cannot follow (`kyma-logs` → `envoyOtelAls` → the OTLP
 *     gateway). Every count over that window is *not read*, not zero.
 *   - **`unprovenZero`** — proxies were tailed, no request line came back, and the log's
 *     destination could not be confirmed (`readable: null` — an unresolved provider name, or an
 *     implementation key this build does not recognise). Consistent with a quiet cluster and
 *     equally consistent with a log this reader cannot see, so it may not be rendered as a
 *     measurement either. `readable === true` is excluded on purpose: a genuinely quiet
 *     stdout-logging cluster has earned its zero.
 *   - **`noEvidence`** — either of the above. The gate every count on both tabs is drawn through.
 *
 * Pure on purpose, so it is unit-tested against payload shapes rather than against a screenshot.
 */
import type { AccessLogVerdict, TrafficWindow } from '../../api';
import type { MetricStatus } from '../../components/unavailable';
import { ago } from '../../format';

/** What each resolved provider kind means, on hover, in an operator's words. */
export const PROVIDER_KIND_WHY: Record<string, string> = {
  file: 'envoyFileAccessLog — Envoy writes the line to a file path. When that path is /dev/stdout it is exactly the stream pods/log returns, so this tab can read it.',
  otlp: 'envoyOtelAls — Envoy streams the line to an OTLP collector over gRPC and writes nothing to the pod. It reaches SAP Cloud Logging, not this tab.',
  grpc: 'An Envoy gRPC access-log service. The line leaves the pod over the wire, so pod stdout carries nothing to read.',
  'not-access-log': 'This provider is declared for tracing or metrics, not access logging. Naming it in accessLogging produces no request lines at all.',
  unknown: 'The mesh config declares this provider with an implementation key this console does not recognise. Whether it writes to stdout is genuinely unknown, so the proxies were still read.',
  unresolved: 'The Telemetry CR names this provider but the mesh ConfigMap declares no extensionProviders entry for it.'
};

export interface AccessLogEvidence {
  /** No proxy was read at all, because the log provably does not reach pod stdout. */
  readsSkipped: boolean;
  /** The read happened, found nothing, and cannot prove one should have been there. */
  unprovenZero: boolean;
  /** Either of the two above: nothing on the page may read as a measurement. */
  noEvidence: boolean;
  /**
   * The access log speaks the OpenTelemetry field names rather than Envoy's.
   *
   * Read off the resolved provider rather than guessed from the rows, because a row with no
   * `upstream_cluster` is indistinguishable either way — and OTel semconv has no such field, so
   * its absence says nothing about whether the request was routed.
   */
  otelFields: boolean;
  /** The status a count derived from this read must carry when `noEvidence`. */
  notRead: MetricStatus;
  /** The window sentence, stated in place rather than in a tooltip. Empty when there is no window. */
  windowLine: string;
}

export function accessLogEvidence(
  log: AccessLogVerdict | undefined,
  w: TrafficWindow | undefined
): AccessLogEvidence {
  const readsSkipped = w?.readsSkipped === true;
  const unprovenZero = !readsSkipped && log?.readable !== true && w?.requestsParsed === 0;
  const noEvidence = readsSkipped || unprovenZero;

  // Short on purpose: `StatTile` clamps its caption to two lines and this sentence is repeated
  // across every tile, so the long-form explanation lives in the banner and the provider table.
  const offPodSinks = (log?.providerDetail ?? [])
    .filter(p => p.readable === false && p.destination)
    .map(p => p.name);
  const skippedWhy = readsSkipped
    ? offPodSinks.length
      ? `not read — ${offPodSinks.join(' and ')} ${offPodSinks.length === 1 ? 'streams' : 'stream'} off the pod`
      : 'not read — nothing writes the access log to pod stdout'
    : 'no request line came back, and the log destination could not be confirmed';

  return {
    readsSkipped,
    unprovenZero,
    noEvidence,
    otelFields: (log?.providerDetail ?? []).some(p => p.readable === true && p.fields === 'otel'),
    notRead: {
      state: 'unavailable',
      what: 'requests',
      why: skippedWhy,
      blind: 1,
      total: 1,
      truncated: false,
      truncatedWhy: ''
    },
    windowLine: !w
      ? ''
      : readsSkipped
        ? `No window — none of ${w.proxyCandidates} proxies were read, because the access log does not reach pod stdout`
        : `${w.requestsParsed.toLocaleString()} request${w.requestsParsed === 1 ? '' : 's'} from ${w.proxiesRead} of ${w.proxyCandidates} proxies, ${w.tailLines} lines each` +
          (w.oldest && w.newest ? `, spanning ${ago(w.oldest)} to ${ago(w.newest)}` : '')
  };
}
