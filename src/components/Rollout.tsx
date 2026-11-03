/**
 * Read-only rollout status.
 *
 * This file used to hold the console's only two cluster mutations — `RestartControl` (a rollout
 * restart) and `ScaleControl` (a `spec.replicas` patch). Both are gone. Kyma Fleet is a strictly
 * read-only observability and investigation platform: it must never change cluster state, and a
 * confirm dialog is not an exemption from that, it is just a slower way to break the rule.
 *
 * What remains is the half that was always read-only and always the more useful half anyway —
 * `GET .../rollout`, which answers "did the rollout this workload is in the middle of actually
 * land?". That is the question an operator has when they open a workload; the button was only
 * ever how they'd respond to the answer, and responding belongs in their own kubectl session
 * where it is audited as theirs.
 *
 * Polling stops on completion, on unmount, and after a hard ceiling — a stuck rollout should
 * surface as "still not complete after five minutes", not as an endless request loop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type RolloutStatus, type WorkloadRow } from '../api';
import { Dot, Pill } from './ui';

const POLL_MS = 5_000;
const MAX_POLLS = 60; // 5 minutes at 5s

export function RolloutStatusView({ cluster, workload }: { cluster: string; workload: WorkloadRow }) {
  const [status, setStatus] = useState<RolloutStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const polls = useRef(0);

  // A different workload selected in the panel must not inherit the previous one's status. The
  // identity string is the dependency rather than the object, because `workload` is a fresh
  // object on every refresh and would restart the poll on each one.
  const identity = `${cluster}/${workload.namespace}/${workload.kind}/${workload.name}`;

  const poll = useCallback(
    async (alive: () => boolean) => {
      try {
        const s = await api.rollout(cluster, workload.namespace, workload.name, workload.kind);
        if (!alive()) return true;
        setStatus(s);
        setError(null);
        return s.complete;
      } catch (err) {
        if (!alive()) return true;
        setError(err instanceof ApiError ? err : new ApiError(String(err), 'UNKNOWN', 0));
        // Stop on error rather than hammering a route that is already failing.
        return true;
      }
    },
    [cluster, workload.namespace, workload.name, workload.kind]
  );

  useEffect(() => {
    let live = true;
    const alive = () => live;
    polls.current = 0;
    setStatus(null);
    setError(null);
    setGaveUp(false);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const done = await poll(alive);
      if (!live || done) return;
      polls.current += 1;
      if (polls.current > MAX_POLLS) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [identity, poll]);

  if (error) {
    return (
      <p className="text-[13px] text-bad">
        <span className="mono">{error.code}</span> — {error.message}
      </p>
    );
  }

  if (!status) return <p className="text-[13px] text-muted">Reading rollout status…</p>;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px]">
          <Dot tone={status.complete ? 'ok' : 'warn'} />
          {status.complete ? 'Rollout complete' : 'Rollout in progress'}
        </span>
        <span className="mono text-[13px] text-muted">
          {status.updated}/{status.desired} updated · {status.available} available · {status.ready} ready
        </span>
      </div>
      {gaveUp && !status.complete && (
        <p className="mt-1.5 text-[13px] text-warn">
          Still not complete after five minutes. Check the events and container states below.
        </p>
      )}
      {status.conditions
        .filter(c => c.status !== 'True' && c.message)
        .map(c => (
          <p key={c.type} className="mt-1.5 text-[13px] text-muted">
            <Pill tone="warn">{c.reason ?? c.type}</Pill> <span className="ml-1">{c.message}</span>
          </p>
        ))}
    </div>
  );
}
