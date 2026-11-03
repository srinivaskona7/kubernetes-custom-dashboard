/**
 * The live object, as YAML — the running object behind any Kind this console can read.
 *
 * ## Why it is here, and why it is *live*
 *
 * A status, a relationship, a handful of facts — none of that is the object. An operator asking
 * "but what does it actually say" had nowhere to go: a Manifest tab shows what Helm *rendered*,
 * and that stops being the running object the moment a webhook, an HPA or a later edit touches
 * it. This pane is the running object, and the label says so in as many words.
 *
 * ## Fetched on demand, not with the payload it is opened from
 *
 * The caller already holds a list of resources; carrying every one of their full objects would
 * turn a modest response into a multi-megabyte one to serve the single object an operator
 * eventually clicks. So this read is lazy and keyed to `fetchKey`: open a drawer and it runs;
 * open another and the key changes and it runs again; open none and it never runs at all.
 *
 * ## Redactions are printed, not implied
 *
 * The server strips Secret values, ConfigMap values and inline container env values — the same
 * rules `factsFor` and `workloads.js` already apply — and returns a list of what it took. That
 * list goes on screen. A blank field a reader takes for the configured value is its own wrong
 * answer, and the point of naming the removal is that `null` here means "not shown to you"
 * rather than "not set".
 */
import { useCallback } from 'react';
import { api } from '../api';
import { CodeViewer } from './CodeViewer';
import { Empty } from './ui';
import { useAsync } from '../useAsync';

/** The running object, read on demand from `/clusters/:id/resources/yaml`, with what the server removed. */
export function LiveYaml({
  clusterId,
  kind,
  namespace,
  name,
  fetchKey
}: {
  clusterId: string;
  kind: string;
  namespace: string | null;
  name: string;
  fetchKey: string;
}): JSX.Element {
  const fetcher = useCallback(
    () => api.clusterResourceYaml(clusterId, kind, namespace, name),
    [clusterId, kind, namespace, name]
  );
  // The primitive key is what makes a new selection refetch. Passing `fetcher` through the deps
  // of the hook instead would loop, because it is a new function on every render.
  const { data, error, initial } = useAsync(fetcher, 0, fetchKey);

  if (initial) return <p className="text-[13px] text-muted">Reading the live object…</p>;

  if (error || !data?.ok || !data.data) {
    return (
      <Empty
        title="The live object could not be read"
        hint={
          data?.error?.message ||
          (error instanceof Error ? error.message : 'The cluster refused or did not answer this read.') +
            ' Nothing is shown rather than a guess at what the object contains.'
        }
      />
    );
  }

  const { yaml, redactions, apiVersion, resourceVersion } = data.data;

  return (
    <CodeViewer
      label="LIVE OBJECT"
      meta={
        <>
          {apiVersion && <span className="mono">{apiVersion}</span>}
          {resourceVersion && <span className="mono"> · rv {resourceVersion}</span>}
        </>
      }
      note={
        redactions.length > 0
          ? `Read from the cluster just now. Removed before it left the server: ${redactions.join('; ')}. A null below is a value this console never carries, not an empty setting.`
          : 'Read from the cluster just now — this is the running object, which may differ from what Helm rendered.'
      }
      text={yaml}
      language="yaml"
      maxHeight="50vh"
    />
  );
}
