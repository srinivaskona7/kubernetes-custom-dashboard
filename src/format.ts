/**
 * Formatters. Small, pure, and in one place because the same duration or byte count is
 * rendered on four different pages and must read identically on all of them.
 */

/** `18h 42m`, the way an operator reads a token countdown. Negative reads as `expired`. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** How long ago, for timestamps. `4m ago`, `2h ago`, `3d ago`. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  return `${duration(diff)} ago`;
}

/** Binary units, because that is what Kubernetes reports. */
export function bytes(n: number | null | undefined): string {
  if (!n) return '0';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * A **capacity** in cores — a node's allocatable, a cluster's requested total. Always rendered
 * next to the word "cores", which is why it stays a decimal: "8.8 cores" is how an operator reads
 * a cluster, and "8800m cores" is not.
 *
 * Not for a single pod or container. See `cpu()` below for why that distinction is load-bearing
 * rather than stylistic.
 */
export function cores(n: number | null | undefined): string {
  if (!n) return '0';
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

/**
 * One pod's or container's CPU quantity, at the precision those values actually have.
 *
 * `cores()` renders a real 7-millicore sample as **"0"** — `0.007.toFixed(1)` is `"0.0"`, and the
 * trailing-zero strip makes it `"0"`. Every pod on a lightly loaded cluster uses single-digit
 * millicores, so the whole CPU column of the Scheduled pods table read `0` while the metrics API
 * was answering correctly for every row. A rendered zero over live data is the same failure as a
 * rendered zero over a failed read: the operator draws a conclusion the data does not support.
 *
 * Below one core this prints millicores — shorter, exact, and the form `kubectl top` uses. At or
 * above one core it prints cores, so a 2.5-core request does not become "2500m".
 *
 * Two formatters for one unit is deliberate and the split is by *subject*, not by taste: a
 * capacity is read in cores beside the word "cores" (`cores()`), a sample or a request for one
 * object is read at millicore precision (`cpu()`). `0` here means a genuine zero; a value that
 * was never read is `null` and every caller renders that as an em dash.
 */
export function cpu(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '0';
  if (n < 1) {
    const milli = Math.round(n * 1000);
    // Under half a millicore. `0m` would be the same lie in a smaller unit, and a real sample
    // this small still means "running, barely" rather than "idle".
    return milli === 0 ? '<1m' : `${milli}m`;
  }
  // `2` rather than `2.0`, `2.5` rather than `2.50`: strip the fraction only when it is all zeros.
  return n < 10 ? n.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(n));
}

export function percent(p: number | null | undefined): string {
  return p === null || p === undefined ? '—' : `${p}%`;
}

/** Utilisation bands: green under 70, amber to 89, red at 90 and above. */
export function band(p: number | null | undefined): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (p === null || p === undefined) return 'unknown';
  if (p >= 90) return 'bad';
  if (p >= 70) return 'warn';
  return 'ok';
}
