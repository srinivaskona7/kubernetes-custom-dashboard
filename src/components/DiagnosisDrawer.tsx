/**
 * The "What went wrong?" slide-over.
 *
 * Every failure badge in this console is a two-word verdict — `OOMKilled`, `OOM risk 91%`, `503`.
 * Two words is right for a table cell and useless to anyone who has not met that failure before,
 * which on a fleet console is most of the people reading it at 3am. This panel is the rest of the
 * sentence: what happened, the mechanism, what to change, and the commands to look with.
 *
 * Three decisions worth keeping:
 *
 *  - **`DetailPanel`, not a new overlay.** It already solves the parts that are easy to get wrong —
 *    modal below 1280px with a real focus trap, inline beside the table above it, Escape closing
 *    either way, and focus handed back to the badge that opened it.
 *  - **Commands are copied, never run.** This console holds a read-only credential and there is no
 *    execution path behind these buttons. A refused clipboard write says so rather than flashing
 *    "Copied" over a copy that did not happen.
 *  - **The unknown case is visible.** `diagnose()` returns `known: false` for a code with no
 *    tailored copy, and the panel prints that rather than dressing the fallback up as an answer.
 */
import { useState } from 'react';
import { DetailPanel } from './layout';
import { Pill, type Tone } from './ui';
import type { Diagnosis } from '../diagnosis';

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);

  const copy = () => {
    if (!navigator.clipboard?.writeText) {
      setRefused(true);
      return;
    }
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setRefused(false);
        setTimeout(() => setCopied(false), 1500);
      },
      // Refused: no permission, or an insecure context. Never claim a copy that did not happen —
      // the operator needs to know to select the text by hand.
      () => setRefused(true)
    );
  };

  return (
    <div className="flex items-start gap-2">
      <code className="mono min-w-0 flex-1 break-all rounded-[6px] border border-line bg-panel/60 px-2 py-1.5 text-[12px] text-text">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-[6px] border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
        title="Copy this command to the clipboard. This console runs nothing — it holds a read-only credential."
        aria-label={`Copy command: ${command}`}
      >
        {copied ? 'Copied' : refused ? 'Blocked' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * The explanation itself, without a panel around it.
 *
 * Exported because two call sites need the same four parts in two different containers: a badge in a
 * table opens `DiagnosisDrawer`, while Ingress & Traffic already has a drawer open on the failing
 * request and needs the explanation *inside* it. One body, so the two can never drift into two
 * different accounts of the same 503.
 */
export function DiagnosisBody({ diagnosis }: { diagnosis: Diagnosis }): JSX.Element {
  return (
    <div className="space-y-4">
      <p className="text-[14px] text-text">{diagnosis.summary}</p>

      <div>
        <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Root cause</p>
        <p className="text-[13px] text-muted">{diagnosis.rootCause}</p>
      </div>

      <div>
        <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">What to do</p>
        {/*
          An ordered list, because the order is the advice: reading the evidence comes before
          changing a spec, and every one of these ends with the operator deciding rather than
          this console recommending a number it cannot know.
        */}
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted">
          {diagnosis.remediation.map(step => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      {diagnosis.commands.length > 0 && (
        <div>
          <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
            Commands for your own shell
          </p>
          <p className="mb-2 text-[12px] text-muted/80">
            Copied, never run. This console reads the cluster with a read-only credential and has no path
            to execute anything.
          </p>
          <div className="space-y-1.5">
            {diagnosis.commands.map(c => (
              <CopyCommand key={c} command={c} />
            ))}
          </div>
        </div>
      )}

      {!diagnosis.known && (
        <p className="rounded-[6px] border border-line bg-panel/40 px-3 py-2 text-[13px] text-muted">
          This console has no tailored explanation for this outcome, so none is invented. The evidence above
          is what was actually observed.
        </p>
      )}
    </div>
  );
}

export function DiagnosisDrawer({ diagnosis, onClose }: { diagnosis: Diagnosis; onClose: () => void }): JSX.Element {
  const tone: Tone = diagnosis.tone;
  return (
    <DetailPanel
      title={
        <span className="flex items-baseline gap-2">
          <Pill tone={tone}>{diagnosis.known ? 'explained' : 'no guidance'}</Pill>
          <span className="truncate text-[14px]">{diagnosis.title}</span>
        </span>
      }
      subtitle="What went wrong, why, and what to do next"
      onClose={onClose}
      inlineClassName="sticky top-0 max-h-[calc(100vh-180px)]"
    >
      <DiagnosisBody diagnosis={diagnosis} />
    </DetailPanel>
  );
}
