/**
 * The line a tab shows while it keeps the previous read on screen (`useAsync`'s `stale`).
 *
 * Changing a log tab's window — a wider tail, polls shown, another namespace — used to blank the
 * whole page, controls included, for the length of a cold read. The rows now stay, and this says
 * whose they are: the previous read, until the new one lands. A failed new read says that instead,
 * so held rows are never mistaken for the window just asked for.
 */
export function StaleReadNotice({ stale, loading, failed, what }: { stale: boolean; loading: boolean; failed: boolean; what: string }) {
  if (!stale) return null;
  return (
    <p role="status" className="mb-3 flex items-center gap-2 text-[13px] text-muted">
      <span
        aria-hidden
        className={`inline-block size-2 shrink-0 rounded-full ${failed ? 'bg-warn' : 'bg-unknown motion-safe:animate-pulse'}`}
      />
      {failed && !loading
        ? `The new read failed, so the ${what} below are still the previous read.`
        : `Re-reading. The ${what} below are the previous read until the new one lands.`}
    </p>
  );
}
