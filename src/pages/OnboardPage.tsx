/**
 * Add Target Cluster — the default path.
 *
 * Three ways in, one form. What differs between them is only which credential the operator has, so
 * the page asks for the kubeconfig and the token side by side and lets the *file* decide:
 *
 *  1. a kubeconfig with a static token             -> connect with the file alone
 *  2. an SSO / exec-OIDC kubeconfig + a token      -> file for the endpoint, token for auth
 *  3. a JSON descriptor from `npm run fleet:input` -> apiUrl, CA and token in one object
 *
 * Case 2 is the common one on a cluster whose admins log in through an identity provider, and it is
 * the reason both inputs are first-class rather than one being a fallback: the file holds the API
 * server address and a base64 CA nobody can type by hand, and the token is minted separately with
 * kubectl. Neither half is optional, and neither is an error.
 *
 * **Signing in at the identity provider is a fourth way, and it is its own page** at
 * `/onboard/advanced`. That placement is a statement about what works: SSO needs this dashboard's
 * callback registered on the provider's OAuth client as an exact string, over https, by somebody
 * with admin on that tenant — a change-window task, not a click. Until it is done the button can
 * only fail, and fail on the *provider's* error page. This page therefore asks for the two things
 * an operator can supply unaided, and links to the other one. Nothing is hidden; the order says
 * which is likely to work right now.
 *
 * Everything shared with that page — reading the file, naming the cluster, the Detected rail — is
 * imported from `./onboard/`, so the two cannot drift apart on what a kubeconfig is.
 *
 * Nothing on this screen displays a credential it was given. The token textarea shows what the
 * operator typed into it; the describe response carries no token, no CA and no argv.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PageProps } from '../App';
import { api, ApiError, type OnboardRequest, type OnboardResult } from '../api';
import { PageHeader } from '../components/layout';
import { Btn, Dot, Pill } from '../components/ui';
import { rosterChanged } from '../roster-signal';
import { KubeconfigField, SourceModeToggle, useKubeconfigSource } from './onboard/kubeconfig';
import { Check, DetectedPanel, IdentityFields, Row, Step } from './onboard/parts';
import { CREDENTIAL_LABEL, clusterIdOf, isJwt, suggestEnv, type Env } from './onboard/shared';

const MINT_COMMAND = 'kubectl create token fleet-reader -n kyma-fleet --duration=24h';

export default function OnboardPage({ onRefreshed }: PageProps) {
  const navigate = useNavigate();

  const src = useKubeconfigSource();
  const [name, setName] = useState('');
  const [env, setEnv] = useState<Env | null>(null);
  const [token, setToken] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [copied, setCopied] = useState(false);

  /** Adopt the file's own name and token once, and only where the operator has typed nothing. */
  useEffect(() => {
    if (src.suggestedName) setName(current => current || src.suggestedName!);
  }, [src.suggestedName]);
  useEffect(() => {
    if (src.fileToken) setToken(current => current || src.fileToken!);
  }, [src.fileToken]);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  /** A blocked clipboard is reported, not swallowed — copying by hand is now the operator's job. */
  function copyMintCommand() {
    const failed = () => setError(new ApiError(
      'Could not copy to the clipboard — your browser blocked it. Select the text and copy it by hand.',
      'CLIPBOARD_DENIED', 0));
    if (!navigator.clipboard?.writeText) return failed();
    navigator.clipboard.writeText(MINT_COMMAND).then(() => {
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    }).catch(failed);
  }

  // ---- readiness. Every condition is stated, and none of them is inferred from silence.
  const endpoint = src.described?.apiUrl || src.direct?.apiUrl || '';
  const caPresent = src.described
    ? src.described.caPresent
    : Boolean(src.direct?.caData.includes('BEGIN CERTIFICATE'));
  const tokenPasted = isJwt(token);
  const fileCarriesToken = Boolean(src.described?.hasStaticToken);
  const haveCredential = tokenPasted || fileCarriesToken;
  const nameValid = clusterIdOf(name).length > 0;
  const ready = nameValid && Boolean(endpoint) && caPresent && haveCredential
    && !src.describing && !src.describeError && !src.fileError;

  /**
   * Whether this file could instead be used on the SSO page.
   *
   * Strictly the server's reading, never a guess: `oidcIssuer` is non-null only when the server
   * found a `kubectl-oidc_login` exec block and parsed an issuer out of its argv. Used only to
   * point at the other page — this one never starts a sign-in.
   */
  const ssoPossible = Boolean(src.described?.oidcIssuer) && !src.direct;

  const blocker = useMemo(() => {
    if (!nameValid) return 'Name the cluster';
    if (!endpoint) return src.mode === 'paste' ? 'Paste the kubeconfig' : 'Upload a kubeconfig or credentials file';
    if (src.describing) return 'Reading the kubeconfig…';
    if (src.describeError || src.fileError) return 'That file could not be read';
    if (!caPresent) return 'No certificate authority in the file';
    if (!haveCredential) return 'Paste a service-account token';
    return null;
  }, [nameValid, endpoint, src.describing, src.describeError, src.fileError, caPresent, haveCredential, src.mode]);

  /**
   * Taking over an id that is already in the fleet.
   *
   * The server answers 409 `CLUSTER_EXISTS` and refuses; the only way through is a second request
   * carrying `replace: true`. That is deliberately not something this page decides on its own —
   * replacing repoints the fleet at a different API server under a name operators already trust,
   * and every dashboard that names the old cluster silently starts describing the new one. So the
   * 409 is shown as a question, and `replace` is only ever sent by the operator's own second click.
   *
   * Holds the exact body the server refused, so the confirmed retry is that request plus one flag
   * rather than a fresh read of form state that may have moved underneath it.
   */
  const [collision, setCollision] = useState<{ clusterId: string; message: string; body: OnboardRequest } | null>(null);

  const baseBody = useCallback((): OnboardRequest => ({
    name: name.trim(),
    env: env || suggestEnv(name),
    ...(src.direct
      ? { apiUrl: src.direct.apiUrl, caData: src.direct.caData }
      : { kubeconfig: src.kubeconfig, ...(src.contextName ? { contextName: src.contextName } : {}) })
  }), [name, env, src.direct, src.kubeconfig, src.contextName]);

  async function send(body: OnboardRequest) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.onboard(body);
      setCollision(null);
      setResult(res);
      // Tell the sidebar now rather than letting its 30s poll find out: the operator is about to
      // click through to the cluster, and a rail that does not list it reads as a failed onboard.
      rosterChanged();
      onRefreshed(new Date().toISOString());
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(String(err), 'UNKNOWN', 0);
      if (apiErr.code === 'CLUSTER_EXISTS' && !body.replace) {
        setCollision({ clusterId: clusterIdOf(body.name), message: apiErr.message, body });
      } else {
        setCollision(null);
        setError(apiErr);
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setCollision(null);
    await send({
      ...baseBody(),
      // Send the token only when one was typed. An empty string would push the server onto the
      // token path with nothing to authenticate with.
      ...(tokenPasted ? { token: token.trim() } : {})
    });
  }

  function startOver() {
    setResult(null);
    src.clear();
    setName('');
    setToken('');
    setEnv(null);
  }

  if (result) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <PageHeader title="Add Target Cluster" subtitle="Connected" />
        <div className="max-w-[720px] space-y-5 page-x pb-10">
          <div className="card-body rounded-[8px] border border-line bg-surface">
            <div className="flex items-center gap-3">
              <Pill tone="ok">Connected</Pill>
              <span className="mono text-[15px] font-semibold text-text">
                {result.cluster.displayName || result.cluster.id}
              </span>
              <span className="mono text-[13px] text-muted">{result.cluster.env.toUpperCase()}</span>
            </div>

            <dl className="mt-4 divide-y divide-line border-y border-line text-[13px]">
              <Row label="API server" value={<span className="mono break-all">{result.cluster.apiUrl}</span>} />
              <Row label="Kubernetes" value={result.kubernetesVersion || 'not reported'} />
              <Row label="Onboarded via" value={result.onboardedVia} />
              <Row label="Token expires" value={<span className="mono">{result.expiresAt}</span>} />
              <Row
                label="Self-renewal"
                value={result.renewable
                  ? 'on — the token mints its own successor at half-life'
                  : <span className="text-warn">off — this cluster goes dark at the expiry above unless the RBAC is fixed</span>}
              />
            </dl>

            {result.steps.length > 0 && (
              <ul className="mt-4 space-y-1.5 text-[13px]">
                {result.steps.map(step => (
                  <li key={step.id} className="flex items-start gap-2">
                    <span className="mt-[6px]"><Dot tone={step.level === 'ok' ? 'ok' : 'warn'} /></span>
                    <span className={step.level === 'ok' ? 'text-muted' : 'text-warn'}>
                      <span className="mono text-text">{step.id}</span> — {step.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex gap-2">
              <Btn variant="primary" onClick={() => navigate(`/clusters/${encodeURIComponent(result.cluster.id)}`)}>
                Open cluster →
              </Btn>
              <Btn onClick={startOver}>Add another</Btn>
            </div>
          </div>
          <p className="px-1 text-[13px] text-muted">{result.note}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title="Add Target Cluster"
        icon="onboard"
        info="The kubeconfig is parsed on the server to read the API server URL and CA \u2014 no credential from it is stored. The dashboard then reads this cluster with the service-account token you paste."
        subtitle="Upload or paste a kubeconfig, then paste a service-account token"
        actions={<Btn onClick={() => navigate('/')}>← Overview</Btn>}
      />

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 page-x pb-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---------------------------------------------------------- the form */}
        <div className="min-w-0 divide-y divide-line rounded-[8px] border border-line bg-surface">
          <Step n={1} title="Identity" hint="How this cluster is labelled across the console">
            <IdentityFields idPrefix="cluster" name={name} setName={setName} env={env} setEnv={setEnv} />
          </Step>

          <Step
            n={2}
            title="Kubeconfig"
            hint="Supplies the API server address and its certificate authority"
            action={<SourceModeToggle src={src} />}
          >
            <KubeconfigField
              src={src}
              idPrefix="kubeconfig"
              dropHint={
                <>
                  <code className="mono text-text">.yaml</code> from{' '}
                  <code className="mono text-text">kubectl config view --raw --minify --flatten</code>, or the{' '}
                  <code className="mono text-text">.json</code> from{' '}
                  <code className="mono text-text">npm run fleet:input</code>
                </>
              }
            />
          </Step>

          <Step
            n={3}
            title="Credential"
            hint={fileCarriesToken
              ? 'The kubeconfig already carries one — paste a different token only to override it'
              : 'The credential the dashboard reads with. Read-only, and it renews itself.'}
          >
            {!fileCarriesToken && (
              <div className="mb-2.5 rounded-[6px] border border-line bg-raised p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                    Mint a token
                  </span>
                  <button type="button" onClick={copyMintCommand} className="text-[12px] font-medium text-accent-bright hover:underline">
                    {copied ? '✓ Copied' : 'Copy command'}
                  </button>
                </div>
                <pre className="mono mt-1.5 overflow-x-auto text-[12px] text-ok select-all">{MINT_COMMAND}</pre>
                <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">
                  Run it against the cluster this kubeconfig points at, then paste the output below.
                  The dashboard verifies it before storing anything.
                </p>
              </div>
            )}

            <label htmlFor="sa-token" className="sr-only">Service-account bearer token</label>
            <textarea
              id="sa-token"
              value={token}
              onChange={e => setToken(e.target.value.trim())}
              rows={3}
              spellCheck={false}
              placeholder="eyJhbGciOiJSUzI1NiIsImtpZCI6…"
              className={`w-full resize-none rounded-[6px] border bg-raised p-2.5 font-mono text-[12px] text-text placeholder:text-muted focus:outline-none ${
                token && !tokenPasted ? 'border-warn' : 'border-line focus:border-accent'
              }`}
            />
            <p className="mt-1 text-[12px] text-muted" aria-live="polite">
              {tokenPasted
                ? <span className="text-ok">Looks like a JWT — it is verified against the cluster on connect</span>
                : token
                  ? <span className="text-warn">A service-account token is three dot-separated parts</span>
                  : fileCarriesToken
                    ? 'Optional — the file already has one'
                    : src.described
                      ? 'Required — the kubeconfig carries no static token'
                      : 'Required unless the kubeconfig turns out to carry one'}
            </p>
          </Step>

          {/* ------------------------------------------------- the other way in.
              A link, not a disclosure. Signing in is a different job with a different
              prerequisite — a callback URI an administrator has to register — so it gets its own
              page rather than folding a second credential path into this one. The badge only
              appears when the server has actually found an issuer in the file on screen. */}
          {!fileCarriesToken && (
            <div className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-line bg-raised/40 p-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-text">
                    Advanced — sign in with SSO instead
                    {ssoPossible && (
                      <span className="mono rounded-[4px] border border-line px-1.5 py-[1px] text-[11px] text-muted">
                        available for this file
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[12px] leading-[1.6] text-muted">
                    Mints the token from your own sign-in at the identity provider instead of from
                    kubectl. Opens its own page, which asks only for the OIDC kubeconfig and a name.
                    Needs this dashboard's callback registered on the provider first.
                  </p>
                </div>
                <Btn onClick={() => navigate('/onboard/advanced')}>Open advanced →</Btn>
              </div>
            </div>
          )}

          {/* A 409 the operator can answer, not an error they can only read.
              Styled `warn` rather than `bad` on purpose: nothing has gone wrong, a decision is
              being asked for — and the destructive-sounding half is spelled out rather than
              hidden behind a word like "overwrite". */}
          {collision && (
            <div className="p-5">
              <div className="rounded-[6px] border border-warn/40 bg-warn/10 p-4">
                <p className="text-[13px] font-semibold text-text">
                  <span className="mono">{collision.clusterId}</span> is already in the fleet
                </p>
                <p className="mt-1 text-[13px] text-muted">{collision.message}</p>
                <p className="mt-2 text-[13px] text-muted">
                  Replacing it points every page that names this cluster — Overview, tokens, drift —
                  at <span className="mono break-all text-text">{endpoint}</span> instead. The
                  existing token is discarded. Nothing about the old cluster is recoverable from here.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Btn onClick={() => void send({ ...collision.body, replace: true })} disabled={busy}>
                    {busy ? 'Replacing…' : `Replace ${collision.clusterId}`}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setCollision(null)} disabled={busy}>
                    Keep the existing cluster
                  </Btn>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-5">
              <p className="rounded-[6px] border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">
                <span className="font-semibold">
                  {error.code === 'CLIPBOARD_DENIED' ? 'Copying failed' : 'The cluster rejected this attempt'}
                </span>
                {' — '}
                <span className="mono">{error.code}</span> — {error.message}
              </p>
            </div>
          )}
        </div>

        {/* ------------------------------------------------- what the file says */}
        <DetectedPanel src={src} endpoint={endpoint} caPresent={caPresent}>
          <ul className="space-y-1.5 text-[13px]">
            <Check done={nameValid} label="Cluster named" />
            <Check done={Boolean(endpoint)} label="API server read from the file" />
            <Check done={caPresent} label="Certificate authority present" />
            <Check
              done={haveCredential}
              label={fileCarriesToken && !tokenPasted ? 'Token supplied by the file' : 'Token pasted'}
            />
          </ul>

          <div className="mt-4 flex items-center gap-2">
            <Btn variant="primary" onClick={() => void submit()} disabled={!ready || busy}>
              {busy ? 'Connecting…' : 'Connect cluster'}
            </Btn>
            <Btn onClick={() => navigate('/')} disabled={busy}>Cancel</Btn>
          </div>
          <p className="mt-2 text-[12px] text-muted" aria-live="polite">
            {blocker || 'Ready — the token is verified against the cluster before anything is stored'}
          </p>

          {/* Only once the server has actually found an issuer. An unconditional pointer here
              would offer SSO for a kubeconfig that names no provider, which is a dead end. */}
          {ssoPossible && !haveCredential && (
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-[1.6] text-muted">
              This kubeconfig logs in through{' '}
              <span className="mono break-all text-text">{src.described?.oidcIssuer}</span>. If you
              would rather sign in than mint a token,{' '}
              <button
                type="button"
                onClick={() => navigate('/onboard/advanced')}
                className="font-medium text-accent-bright hover:underline"
              >
                open the advanced page
              </button>
              .
            </p>
          )}

          {/* Why a file that is not a kubeconfig cannot go the other way, stated where the
              question arises rather than left to be discovered on the other page. */}
          {src.direct && (
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-[1.6] text-muted">
              This is a JSON credentials descriptor —{' '}
              {src.described ? CREDENTIAL_LABEL[src.described.credential] : 'apiUrl, CA and token in one object'}.
              It names no identity provider, so SSO does not apply to it.
            </p>
          )}
        </DetectedPanel>
      </div>
    </div>
  );
}
