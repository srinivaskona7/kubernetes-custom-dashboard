/**
 * The furniture both onboarding pages are built from: the numbered step, the identity fields, the
 * Detected rail and its checklist.
 *
 * Extracted rather than copied, because these are the parts that encode judgements — how a value
 * too long for the rail is wrapped, which checklist line gets the emphasis, whether a missing CA
 * reads as a warning or a refusal. A second copy keeps the markup and loses the judgement the
 * first time either page is edited.
 */
import { Dot } from '../../components/ui';
import { CREDENTIAL_LABEL, ENVIRONMENTS, clusterIdOf, suggestEnv, type Env } from './shared';
import type { KubeconfigSource } from './kubeconfig';

/** One numbered step. A divided list rather than nested cards — the page is one object. */
export function Step({
  n, title, hint, action, children
}: {
  n: number;
  title: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="p-5">
      <header className="mb-3 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="mono text-[12px] font-semibold text-accent">{n}</span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text">{title}</h2>
            <p className="text-[12px] text-muted">{hint}</p>
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * One row of the Detected panel: label above value, not beside it.
 *
 * A fixed label column left ~164px for the value inside a 340px rail, which broke an API server
 * URL over three lines mid-token — `https://api.c-77aa9` / `31.kyma.ondemand.co` / `m`. This panel
 * exists so an operator can confirm they pasted the right cluster, and a shoot id split across a
 * line wrap is exactly the thing they cannot verify at a glance. Stacking gives the value the full
 * width at every breakpoint, and the label costs one 14px line.
 */
export function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-2">
      <dt className="text-[12px] uppercase tracking-[0.04em] text-muted">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-text">{value}</dd>
    </div>
  );
}

/**
 * One line of the readiness checklist.
 *
 * The emphasis runs the opposite way to the obvious one: a **pending** item is the brightest line
 * and a done item is muted. The list exists to answer "what is left", and rendering the
 * outstanding item dimmer than the finished ones — with only an 8px dot to carry it — buries the
 * only line the operator still has to act on.
 *
 * `pending` is a third state, not a cosmetic one: a requirement that is unmet but has a route to
 * being met reads differently from one that is simply outstanding.
 */
export function Check({ done, label, pending }: { done: boolean; label: string; pending?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <Dot tone={done ? 'ok' : pending ? 'warn' : 'unknown'} />
      <span className={pending && !done ? 'font-medium text-warn' : 'text-muted'}>{label}</span>
    </li>
  );
}

/** Reference name and environment. Identical on both pages, down to the id preview. */
export function IdentityFields({
  idPrefix,
  name,
  setName,
  env,
  setEnv
}: {
  idPrefix: string;
  name: string;
  setName: (s: string) => void;
  env: Env | null;
  setEnv: (e: Env) => void;
}) {
  const nameValid = clusterIdOf(name).length > 0;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
      <div>
        <label htmlFor={`${idPrefix}-name`} className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
          Reference name
        </label>
        <input
          id={`${idPrefix}-name`}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Platform Sandbox"
          className="h-9 w-full rounded-[6px] border border-line bg-raised px-3 text-[14px] text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <p className="mt-1 text-[12px] text-muted">
          {nameValid
            ? <>URL and id: <code className="mono text-text">{clusterIdOf(name)}</code></>
            : 'Letters, digits and hyphens — it becomes the cluster id in the URL'}
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-env`} className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
          Environment
        </label>
        <select
          id={`${idPrefix}-env`}
          value={env || suggestEnv(name)}
          onChange={e => setEnv(e.target.value as Env)}
          className="h-9 w-full rounded-[6px] border border-line bg-raised px-2.5 text-[14px] text-text focus:border-accent focus:outline-none"
        >
          {ENVIRONMENTS.map(e => <option key={e} value={e}>{e.toUpperCase()}</option>)}
        </select>
        <p className="mt-1 text-[12px] text-muted">{env ? 'Chosen' : 'Suggested from the name'}</p>
      </div>
    </div>
  );
}

/**
 * What the server read out of the file.
 *
 * Every line is the server's answer, never the page's guess — which is why "missing" and
 * "unavailable" are distinct words here and why nothing defaults to a reassuring value.
 */
export function DetectedPanel({
  src,
  endpoint,
  caPresent,
  children
}: {
  src: KubeconfigSource;
  endpoint: string;
  caPresent: boolean;
  /** The checklist and the page's primary action, which differ between the two pages. */
  children: React.ReactNode;
}) {
  const { described, direct, describing, describeError } = src;
  return (
    // Sticky from `lg`, not `xl`. At 1024-1279 the layout stacks and the aside carries the primary
    // action, so a non-sticky rail put the CTA ~600px below the last field with the whole Detected
    // table in between — no visible action in a half-screen window.
    <aside className="min-w-0 rounded-[8px] border border-line bg-surface lg:sticky lg:top-5">
      <header className="panel-head flex h-[44px] items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Detected</h2>
        {describing && <span className="text-[12px] text-muted">reading…</span>}
      </header>

      {!endpoint && !describeError ? (
        <p className="panel-x py-5 text-[13px] text-muted">
          Nothing read yet. The API server, certificate authority and authentication method are taken
          from the file — none of them is guessed.
        </p>
      ) : (
        <dl className="divide-y divide-line text-[13px]">
          <Row label="API server" value={endpoint
            ? <span className="mono break-all text-text">{endpoint}</span>
            : <span className="text-muted">unavailable</span>} />
          <Row label="Context" value={described
            ? <span className="mono text-text">{described.contextName}</span>
            : <span className="text-muted">not a kubeconfig</span>} />
          <Row
            label="Certificate authority"
            value={caPresent
              ? <span className="text-ok">present</span>
              : <span className="text-bad">missing — the API server cannot be verified</span>}
          />
          <Row
            label="File's credential"
            value={described
              ? <span className={described.hasStaticToken ? 'text-ok' : 'text-warn'}>{CREDENTIAL_LABEL[described.credential]}</span>
              : direct?.token ? <span className="text-ok">token in descriptor</span> : <span className="text-muted">none</span>}
          />
          {described?.oidcIssuer && (
            <Row label="OIDC issuer" value={<span className="mono break-all text-muted">{described.oidcIssuer}</span>} />
          )}
          {described?.defaultNamespace && (
            <Row label="Default namespace" value={<span className="mono text-muted">{described.defaultNamespace}</span>} />
          )}
        </dl>
      )}

      <div className="border-t border-line p-4">{children}</div>
    </aside>
  );
}
