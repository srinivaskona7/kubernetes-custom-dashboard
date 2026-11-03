/**
 * Reading one container's tail. The only place in the console that calls `api.logs`.
 *
 * Both log surfaces — the Live Pod Logs tab and the bottom drawer — go through here, which is what
 * makes "one log implementation" true rather than aspirational: there is a single fetcher, a single
 * `useAsync` key, and a single filter-then-order pipeline. A second copy would drift on the two
 * details that are easy to get wrong and invisible when wrong (which changes re-fetch, and which
 * order the filters run in).
 *
 * View state is *not* owned here. The tab keeps tail/order/filter in the URL so a log can be linked;
 * the drawer keeps them in component state so opening it does not rewrite the page's URL. Both pass
 * the same shape in, so the difference stays at the call site instead of forking the reader.
 */
import { useCallback, useMemo } from 'react';
import { api, type LogLine } from '../../api';
import { useAsync } from '../../useAsync';
import { orderLines, type LogDirection } from '../../pages/cluster-tabs/log-pods';
import { splitByLevel, type LevelFloor } from './level';

export interface PodLogQuery {
  cluster: string;
  /** Null while nothing is selected — the hook then makes no request at all. */
  namespace: string | null;
  pod: string | null;
  container: string | null;
  tailLines: number;
  previous: boolean;
  /** Poll interval in ms; 0 is off. */
  autoMs: number;
  dir: LogDirection;
  /** Free-text match against the line, case-insensitive. */
  search: string;
  level: LevelFloor;
}

export interface PodLogRead {
  loading: boolean;
  initial: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /** Filtered and ordered for reading. */
  lines: LogLine[];
  /** The raw window in the server's order — the watermark's reference. See `PodLogsViewer`. */
  stream: readonly LogLine[];
  total: number;
  truncated: boolean;
  /** The byte ceiling was reached — see `logCutSentences`. Absent on an older server. */
  bytesTruncated: boolean;
  /** Lines the byte cut sliced through and had to discard. Absent on an older server. */
  partialLinesDropped: number;
  fetchedAt: string | null;
  filtered: boolean;
  unclassified: number;
  /** Identifies *which* log this is, for the viewer's re-anchor rule. */
  streamKey: string;
  reload: () => void;
}

export function usePodLogTail(q: PodLogQuery): PodLogRead {
  const { cluster, namespace, pod, container, tailLines, previous, autoMs, dir, search, level } = q;

  const fetcher = useCallback(() => {
    if (!namespace || !pod || !container) return Promise.resolve(null);
    return api.logs(cluster, { namespace, pod, container, tailLines, previous });
  }, [cluster, namespace, pod, container, tailLines, previous]);

  // The key, not the fetcher, is what makes a selection change land without a manual Reload:
  // `fetcher` is rebuilt every render, so `useAsync` cannot watch it. Only the parameters that
  // change *the request* belong here — `dir`, `search` and `level` are applied below to lines
  // already in hand, and listing them would re-read the container on every keystroke.
  const key = namespace && pod && container ? `${cluster}/${namespace}/${pod}/${container}/${tailLines}/${previous}` : null;
  const log = useAsync(fetcher, autoMs, key);

  const stream = log.data?.lines ?? [];

  // Level first, then text, then order. Ordering last is not a style choice: reversing 2,000 lines
  // and *then* discarding most of them is the same result for twenty times the work on every
  // keystroke of the search box.
  const { lines, unclassified } = useMemo(() => {
    const byLevel = splitByLevel(stream, level);
    const needle = search.trim().toLowerCase();
    const kept = needle ? byLevel.kept.filter(l => l.message.toLowerCase().includes(needle)) : byLevel.kept;
    return { lines: orderLines(kept, dir), unclassified: byLevel.unclassified };
  }, [stream, level, search, dir]);

  return {
    loading: log.loading,
    initial: log.initial,
    errorCode: log.error?.code ?? null,
    errorMessage: log.error?.message ?? null,
    lines,
    stream,
    total: stream.length,
    truncated: log.data?.truncated ?? false,
    bytesTruncated: log.data?.bytesTruncated ?? false,
    partialLinesDropped: log.data?.partialLinesDropped ?? 0,
    fetchedAt: log.data?.fetchedAt ?? null,
    filtered: Boolean(search.trim()) || level !== 'all',
    unclassified,
    /* The subject, not the query: `previous` and `tailLines` change *how much* of the same log is
       read and must not throw the reader back to the newest line, whereas a different pod or
       container is a different log entirely. `dir` is in the key because flipping the order
       relocates the newest line to the other edge — the scroller must re-anchor there, not sit at
       whatever offset it held. */
    streamKey: `${cluster}/${namespace}/${pod}/${container}/${dir}`,
    reload: log.reload
  };
}
