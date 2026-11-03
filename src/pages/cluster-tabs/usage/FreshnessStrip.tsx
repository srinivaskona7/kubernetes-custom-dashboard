import { useEffect, useState } from 'react';
import { Btn } from '../../../components/ui';

/**
 * When the snapshot on screen was last true, and a way to ask for a newer one.
 *
 * The cluster page polls every 30s on its own, so this is not the only path to fresh data — it is
 * how an operator who just changed something gets an answer without waiting out the interval, and
 * how anyone reading a number learns whether it is seconds or minutes old. Reading again is the
 * only action here; nothing here writes to the cluster.
 */
export function FreshnessStrip({ fetchedAt, onRefresh }: { fetchedAt: number | null; onRefresh: () => void }): JSX.Element {
  // A relative age is wrong the moment it is painted unless something re-paints it. One second is
  // the resolution the label claims, so it is the interval this ticks at.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const age = fetchedAt === null ? null : Math.max(0, Math.round((now - fetchedAt) / 1000));

  return (
    <div className="flex items-center gap-3 text-[12px] text-muted">
      <span
        className="border-b border-dotted border-muted/60 pb-px"
        title="Every number here comes from one collection pass. There is no history behind it and no averaging over time."
      >
        Snapshot
      </span>
      <span className="mono" aria-live="polite">
        {age === null
          ? 'not loaded yet'
          : age < 60
            ? `updated ${age}s ago`
            : `updated ${Math.floor(age / 60)}m ${age % 60}s ago`}
      </span>
      <Btn onClick={onRefresh} title="Read this cluster again now. The page also refreshes on its own every 30 seconds.">
        Refresh
      </Btn>
    </div>
  );
}
