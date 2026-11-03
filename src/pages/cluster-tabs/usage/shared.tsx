/**
 * The formatters and cells Top Consumers shares with the rest of the console.
 *
 * A heuristic is labelled here rather than trusted to each table: `<PressurePill>` marks a
 * threshold this console chose with a dotted underline and a tooltip that says Kubernetes defines
 * no such state.
 */
import { bytes } from '../../../format';
import { Dot, type Tone } from '../../../components/ui';
import { MEMORY_CRITICAL_FRACTION, MEMORY_NEAR_FRACTION, type PressureFinding } from './utilization-model';

/** Bytes, via the shared formatter so a gigabyte reads the same here as on the Nodes tab. */
export function mem(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return bytes(n);
}

/** A fraction as a percentage string. One decimal below 10% so a 0.4% row is not "0%". */
export function pct(f: number): string {
  const p = f * 100;
  if (p >= 100) return `${Math.round(p)}%`;
  if (p >= 10) return `${p.toFixed(0)}%`;
  return `${p.toFixed(1)}%`;
}

/** A share of the cluster, or an em-dash. Never 0% for an unknown share. */
export function share(f: number | null): string {
  return f === null ? '—' : pct(f);
}

/**
 * One pressure finding as a pill.
 *
 * A heuristic gets a dashed underline and says so in its tooltip. That is the whole distinction
 * the `basis` field exists to carry: "OOMKilled" is the kubelet's word and "Near memory limit" is
 * this console's threshold, and an operator escalating an incident needs to know which is which.
 */
export function PressurePill({ finding }: { finding: PressureFinding }): JSX.Element {
  const tone: Tone =
    finding.kind === 'oom-killed' || finding.kind === 'unschedulable' || finding.kind === 'memory-critical'
      ? 'bad'
      : finding.kind === 'memory-near-limit' || finding.kind === 'restarts'
        ? 'warn'
        : 'unknown';
  const why =
    finding.basis === 'heuristic'
      ? `${finding.detail}. Threshold chosen by this console (${pct(MEMORY_NEAR_FRACTION)} near, ${pct(
          MEMORY_CRITICAL_FRACTION
        )} critical) — Kubernetes defines no "near limit" state.`
      : finding.detail;
  return (
    <span
      tabIndex={0}
      title={why}
      className={`inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-px text-[12px] ${
        tone === 'bad' ? 'border-bad/40 text-bad' : tone === 'warn' ? 'border-warn/40 text-warn' : 'border-line text-muted'
      } ${finding.basis === 'heuristic' ? 'border-dashed' : ''}`}
    >
      <Dot tone={tone} />
      {finding.label}
      {finding.basis === 'heuristic' && <span className="sr-only"> (heuristic threshold)</span>}
    </span>
  );
}

/** Every finding on one row, worst first, or a quiet dash. */
export function PressureCell({ findings }: { findings: readonly PressureFinding[] }): JSX.Element {
  if (!findings.length) return <span className="mono text-muted">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {findings.map(f => (
        <PressurePill key={f.kind} finding={f} />
      ))}
    </span>
  );
}
