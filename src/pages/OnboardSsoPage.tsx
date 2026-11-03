/**
 * Add Target Cluster — Advanced: sign in at the identity provider.
 *
 * Its own page rather than a section of `/onboard`, because it is a different job with a different
 * prerequisite. The default page asks for two things an operator can produce unaided: a kubeconfig
 * and a token from `kubectl create token`. This page asks for one thing they cannot — a callback
 * URI registered on the identity provider's OAuth client, over https, as an exact string, by
 * somebody holding admin on that tenant. Until that registration exists the button here can only
 * fail, and it fails on the *provider's* error page rather than this one.
 *
 * So the two are separated: `/onboard` is the path that works today, and this is the path that
 * works once an administrator has done their part. Everything here is about that one route, which
 * is why there is no token field on it at all.
 *
 * ## What is asked for, and in what order
 *
 * 1. Name the cluster.
 * 2. Upload or paste an exec-OIDC kubeconfig. The *server* parses it and reports the issuer; this
 *    page never reads the YAML itself.
 * 3. Sign in. A second tab opens at the issuer, the operator authenticates there, and the tab
 *    reports the outcome back over `BroadcastChannel` and closes itself. This page keeps
 *    everything that was typed into it.
 *
 * The sign-in is used **once, on the server**, to mint a 24-hour read-only `fleet-reader` token.
 * The operator's own credential is never stored, never sent to the browser, and never used to read
 * the cluster afterwards. Nothing on this screen displays a credential: the describe response
 * carries no token, no CA and no argv, and the SSO round trip returns an outcome word and a
 * cluster id.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { PageProps } from '../App';
import { api, ApiError, type Me, type OnboardRequest } from '../api';
import { PageHeader } from '../components/layout';
import { Btn, Dot, Pill } from '../components/ui';
import { rosterChanged } from '../roster-signal';
import { KubeconfigField, SourceModeToggle, useKubeconfigSource } from './onboard/kubeconfig';
import { Check, DetectedPanel, IdentityFields, Step } from './onboard/parts';
import {
  SSO_CHANNEL,
  SSO_WINDOW,
  clusterIdOf,
  fmtClock,
  isSignInTab,
  suggestEnv,
  type Env,
  type SsoOutcome
} from './onboard/shared';

export default function OnboardSsoPage({ onRefreshed }: PageProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const src = useKubeconfigSource({ acceptDescriptor: false });
  const [name, setName] = useState('');
  const [env, setEnv] = useState<Env | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [copied, setCopied] = useState(false);

  /** Adopt the file's own name once, and only while the operator has not typed one. */
  useEffect(() => {
    if (src.suggestedName) setName(current => current || src.suggestedName!);
  }, [src.suggestedName]);

  /**
   * The outcome of an SSO round trip.
   *
   * It reaches this component by one of two routes, because the sign-in happens in a **second
   * tab**: normally the sign-in tab broadcasts it here and closes itself, but if it could not
   * close — or if the popup was blocked and we fell back to navigating this tab — the same outcome
   * is read off the URL the server redirected to. Either way it carries an outcome word plus a
   * cluster id or an error code, and never a credential.
   *
   * Consumed once and then stripped with `replace: true`, so a refresh does not re-announce a
   * connection that happened minutes ago and the back button does not step into a stale banner.
   */
  const [ssoOutcome, setSsoOutcome] = useState<SsoOutcome | null>(null);

  /**
   * A sign-in tab is open and we are waiting on it.
   *
   * Held so this tab can say what it is waiting for, re-focus a tab the operator lost behind the
   * window, and notice that the tab was closed without finishing. `authorizationUrl` is kept for
   * the re-open, which reuses the same named window rather than stacking up tabs.
   */
  const [pending, setPending] = useState<
    { flowId: string; authorizationUrl: string; expiresAt: string; abandoned: boolean } | null
  >(null);
  const ssoWindow = useRef<Window | null>(null);

  const applyOutcome = useCallback((o: SsoOutcome) => {
    setPending(null);
    setBusy(false);
    setSsoOutcome(o);
    if (o.state === 'connected') {
      rosterChanged();
      onRefreshed(new Date().toISOString());
    }
  }, [onRefreshed]);

  /**
   * Read an outcome off the URL.
   *
   * Two tabs run this component, and which one this is decides what happens. In the **sign-in
   * tab** the operator's kubeconfig and typed name are not here — they are in the console tab — so
   * the outcome is broadcast there and this tab closes. The banner is still rendered locally
   * first: `window.close()` is a request, not a guarantee, and a tab that ignored it must not be
   * left showing a blank form.
   */
  useEffect(() => {
    const sso = searchParams.get('sso');
    if (!sso) return;
    const outcome: SsoOutcome = sso === 'connected'
      ? { state: 'connected', clusterId: searchParams.get('cluster') || '' }
      : {
          state: 'failed',
          code: searchParams.get('code') || 'OIDC_FAILED',
          message: searchParams.get('message') || 'the sign-in did not complete'
        };

    // Broadcast unconditionally, close conditionally. The console tab is the one that must learn
    // the outcome, and a channel message costs nothing when nobody is listening — whereas
    // `window.name` can be cleared by a cross-origin round trip in some browsers, so gating the
    // *message* on it would lose the result exactly when the tab detection is least reliable.
    try {
      const ch = new BroadcastChannel(SSO_CHANNEL);
      ch.postMessage(outcome);
      if (isSignInTab()) {
        // Drop the marker first. If the close is refused the operator keeps this tab, and a tab
        // still answering to the sign-in name would close itself out from under them next time.
        window.name = '';
        // Give the message a tick to leave before the tab goes; closing at once can drop it.
        window.setTimeout(() => { ch.close(); window.close(); }, 150);
      } else {
        ch.close();
      }
    } catch {
      // No BroadcastChannel: stay open and show the result here rather than vanish with it.
    }

    applyOutcome(outcome);
    const next = new URLSearchParams(searchParams);
    for (const k of ['sso', 'cluster', 'code', 'message']) next.delete(k);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, applyOutcome]);

  /** The console tab's side of the same conversation. */
  useEffect(() => {
    let ch: BroadcastChannel;
    try {
      ch = new BroadcastChannel(SSO_CHANNEL);
    } catch {
      return;
    }
    ch.onmessage = e => {
      const o = e.data as SsoOutcome | undefined;
      if (o && (o.state === 'connected' || o.state === 'failed')) applyOutcome(o);
    };
    return () => ch.close();
  }, [applyOutcome]);

  /**
   * Notice a sign-in tab that was closed without answering.
   *
   * Reported as exactly that — closed, outcome unknown. Guessing "cancelled" would be a verdict
   * the console has not earned: the flow may well have completed server-side a moment before.
   */
  useEffect(() => {
    if (!pending || pending.abandoned) return;
    const timer = window.setInterval(() => {
      if (ssoWindow.current?.closed) {
        ssoWindow.current = null;
        setPending(p => (p && !p.abandoned ? { ...p, abandoned: true } : p));
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [pending]);

  /**
   * Un-wedge the form after a Back out of the popup-blocked fallback.
   *
   * That path commits a navigation with `busy` still true and no reset, deliberately — the tab is
   * leaving. If the identity provider then refuses and the operator comes back, the page is
   * restored from bfcache with `busy` frozen true and every button disabled with no way to recover
   * short of a reload. `persisted` is what distinguishes a restore from a load.
   */
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setBusy(false); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  /**
   * The callback URI an administrator has to register, read from the server.
   *
   * Never assembled from `window.location`: that is the wrong host behind both the vite proxy and
   * the approuter, and the entire value of this string is that it matches character for character
   * what the issuer will be sent. Left null if `/me` does not report it, in which case the panel
   * omits the line rather than printing a guess.
   */
  const [callback, setCallback] = useState<{
    url: string | null;
    configured: boolean;
    secure: boolean;
    problem: Me['ssoCallbackUrlProblem'];
  }>({ url: null, configured: true, secure: true, problem: null });
  useEffect(() => {
    let alive = true;
    api.me()
      .then(me => {
        if (!alive) return;
        setCallback({
          url: me.ssoCallbackUrl ?? null,
          configured: me.ssoCallbackUrlConfigured !== false,
          // Only `false` is a finding. An older server reports neither field, and treating a
          // missing field as insecure would warn about a deployment nobody changed.
          secure: me.ssoCallbackUrlSecure !== false,
          problem: me.ssoCallbackUrlProblem ?? null
        });
      })
      .catch(() => { /* the panel just omits the line; this is not worth an error banner */ });
    return () => { alive = false; };
  }, []);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  function copyUri(value: string) {
    const failed = () => setError(new ApiError(
      'Could not copy to the clipboard — your browser blocked it. Select the text and copy it by hand.',
      'CLIPBOARD_DENIED', 0));
    if (!navigator.clipboard?.writeText) return failed();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    }).catch(failed);
  }

  // ---- readiness. Every condition is stated, and none of them is inferred from silence.
  const endpoint = src.described?.apiUrl || '';
  const caPresent = Boolean(src.described?.caPresent);
  const nameValid = clusterIdOf(name).length > 0;
  /**
   * Strictly the server's reading of the file, never the page's guess: `oidcIssuer` is non-null
   * only when the server found a `kubectl-oidc_login` exec block and parsed an issuer out of its
   * argv. Without one there is nowhere to send the operator.
   */
  const issuer = src.described?.oidcIssuer || null;
  const ready = nameValid && Boolean(endpoint) && caPresent && Boolean(issuer)
    && !src.describing && !src.describeError;
  const waiting = Boolean(pending && !pending.abandoned);

  const blocker = !nameValid
    ? 'Name the cluster'
    : !endpoint
      ? (src.mode === 'paste' ? 'Paste an OIDC kubeconfig' : 'Upload an OIDC kubeconfig')
      : src.describing
        ? 'Reading the kubeconfig…'
        : src.describeError || src.fileError
          ? 'That file could not be read'
          : !caPresent
            ? 'No certificate authority in the file'
            : !issuer
              ? 'That kubeconfig names no identity provider'
              : null;

  /**
   * Taking over an id that is already in the fleet.
   *
   * The server answers 409 `CLUSTER_EXISTS` and refuses; the only way through is a second request
   * carrying `replace: true`. That is deliberately not something this page decides on its own —
   * replacing repoints the fleet at a different API server under a name operators already trust.
   * So the 409 is shown as a question, and `replace` is only ever sent by the operator's own
   * second click. The exact refused body is held, so the retry is that request plus one flag
   * rather than a fresh read of form state that may have moved underneath it.
   */
  const [collision, setCollision] = useState<{ clusterId: string; message: string; body: OnboardRequest } | null>(null);

  const baseBody = useCallback((): OnboardRequest => ({
    name: name.trim(),
    env: env || suggestEnv(name),
    kubeconfig: src.kubeconfig,
    ...(src.contextName ? { contextName: src.contextName } : {})
  }), [name, env, src.kubeconfig, src.contextName]);

  /**
   * Start the server-mediated sign-in, then hand a **second tab** to the issuer.
   *
   * A new tab rather than this one, because this one holds work: the uploaded kubeconfig, the
   * typed name, the described result. Navigating away throws all of that out, and the case where
   * that hurts most is the common failure — an unregistered redirect URI, where the provider stops
   * the operator on its own error page and the back button returns them to an empty form.
   *
   * `window.open` from inside a click handler is a user gesture, which is what popup blockers
   * actually key on, so this is not the blocked-by-default case. It can still be refused by
   * policy, and then we fall back to navigating this tab — the flow works either way, because the
   * PKCE verifier lives in the server's memory keyed by the `state` on the authorization URL, not
   * in any browser tab.
   */
  async function startSso(override?: OnboardRequest) {
    setBusy(true);
    setError(null);
    setSsoOutcome(null);
    const body: OnboardRequest = override ?? baseBody();
    const replace = body.replace === true;
    try {
      const started = await api.bootstrapOidc(body);
      setCollision(null);
      const opened = window.open(started.authorizationUrl, SSO_WINDOW);
      if (!opened) {
        // Popup refused. Same flow, this tab — losing the form beats losing the ability to sign in.
        window.location.assign(started.authorizationUrl);
        return; // no setBusy(false): the navigation is committed
      }
      ssoWindow.current = opened;
      opened.focus();
      setPending({
        flowId: started.flowId,
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt,
        abandoned: false
      });
      setBusy(false);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(String(err), 'UNKNOWN', 0);
      if (apiErr.code === 'CLUSTER_EXISTS' && !replace) {
        setCollision({ clusterId: clusterIdOf(body.name), message: apiErr.message, body });
      } else {
        setCollision(null);
        setError(apiErr);
      }
      setBusy(false);
    }
  }

  /**
   * Back from a successful round trip.
   *
   * A thinner panel than the token path's, and honestly so: that one renders the 201 body the
   * request returned, and this one has nothing but what survived a redirect. Inventing the missing
   * rows — expiry, Kubernetes version, the bootstrap steps — would mean printing values the page
   * was never told, so it links to the cluster instead, where all of it is real.
   */
  if (ssoOutcome?.state === 'connected') {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <PageHeader title="Add Target Cluster" subtitle="Connected with SSO" />
        <div className="max-w-[720px] space-y-5 page-x pb-10">
          <div className="card-body rounded-[8px] border border-line bg-surface">
            <div className="flex items-center gap-3">
              <Pill tone="ok">Connected</Pill>
              <span className="mono text-[15px] font-semibold text-text">{ssoOutcome.clusterId}</span>
              <span className="text-[13px] text-muted">via SSO</span>
            </div>
            <p className="mt-3 text-[13px] leading-[1.7] text-muted">
              Your sign-in was used once, on the server, to mint a 24-hour read-only{' '}
              <code className="mono text-text">fleet-reader</code> token. From here the cluster is
              read with that token like any other, and it renews itself at half-life — you will not
              be asked to sign in again. Your own credential was not stored.
            </p>
            <div className="mt-5 flex gap-2">
              <Btn variant="primary" onClick={() => navigate(`/clusters/${encodeURIComponent(ssoOutcome.clusterId)}`)}>
                Open cluster →
              </Btn>
              <Btn onClick={() => { setSsoOutcome(null); src.clear(); setName(''); setEnv(null); }}>
                Add another
              </Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title="Add Target Cluster — Advanced"
        icon="onboard"
        info="Runs the OIDC flow named by the kubeconfig against the identity provider, in your browser, with PKCE. The resulting token is short-lived and the dashboard stores no password."
        subtitle="Sign in at the identity provider named by an OIDC kubeconfig"
        actions={<Btn onClick={() => navigate('/onboard')}>← Use a token instead</Btn>}
      />

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 page-x pb-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 divide-y divide-line rounded-[8px] border border-line bg-surface">
          <Step n={1} title="Identity" hint="How this cluster is labelled across the console">
            <IdentityFields idPrefix="sso-cluster" name={name} setName={setName} env={env} setEnv={setEnv} />
          </Step>

          <Step
            n={2}
            title="OIDC kubeconfig"
            hint="Supplies the API server, its certificate authority, and the identity provider to sign in to"
            action={<SourceModeToggle src={src} />}
          >
            <KubeconfigField
              src={src}
              idPrefix="sso-kubeconfig"
              dropHint={
                <>
                  The <code className="mono text-text">.yaml</code> your cluster's admin console
                  issues — the one whose user runs{' '}
                  <code className="mono text-text">kubectl-oidc_login</code>. A kubeconfig with a
                  static token has no provider to sign in to; use{' '}
                  <span className="text-text">Add Cluster</span> for that.
                </>
              }
            />

            {src.described && !issuer && !src.describeError && (
              <p className="mt-3 rounded-[6px] border border-warn/40 bg-warn/10 p-2.5 text-[13px] leading-[1.6] text-warn">
                This kubeconfig names no identity provider, so there is nothing to sign in to. SSO
                needs a <code className="mono">kubectl-oidc_login</code> exec block. Go back and
                pair this file with a service-account token instead.
              </p>
            )}
          </Step>

          <Step
            n={3}
            title="Sign in"
            hint="Opens a second tab at the identity provider and leaves this page exactly as it is"
          >
            {!issuer ? (
              <p className="rounded-[6px] border border-line bg-raised/40 p-3 text-[13px] leading-[1.6] text-muted">
                The sign-in appears here once the file above names an identity provider.
              </p>
            ) : (
              <div className="rounded-[6px] border border-accent/40 bg-accent/5 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-text">Sign in with SSO</div>
                    <div className="mono mt-0.5 truncate text-[12px] text-muted">{issuer}</div>
                  </div>
                  <Btn variant="primary" onClick={() => void startSso()} disabled={!ready || busy || waiting}>
                    {busy ? 'Starting…' : waiting ? 'Waiting…' : 'Sign in →'}
                  </Btn>
                </div>

                {pending && (
                  <div className="mt-3 border-t border-line pt-3">
                    {pending.abandoned ? (
                      <>
                        <div className="flex items-center gap-2 text-[13px] text-text">
                          <Dot tone="warn" />
                          The sign-in tab was closed before it reported back
                        </div>
                        <p className="mt-1 text-[12px] leading-[1.6] text-muted">
                          The console cannot tell whether the sign-in finished — it only knows the
                          tab is gone. Check the cluster list before retrying; if it is not there,
                          open the sign-in again.
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 text-[13px] text-text">
                          <Dot tone="unknown" />
                          Waiting for the sign-in tab
                        </div>
                        <p className="mt-1 text-[12px] leading-[1.6] text-muted">
                          A second tab opened at the identity provider. Finish there and it will
                          close itself and report back here — everything you have typed on this page
                          stays as it is. This sign-in expires at{' '}
                          <span className="mono text-text">{fmtClock(pending.expiresAt)}</span>.
                        </p>
                      </>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Btn
                        onClick={() => {
                          const w = window.open(pending.authorizationUrl, SSO_WINDOW);
                          if (w) {
                            ssoWindow.current = w;
                            w.focus();
                            setPending(p => (p ? { ...p, abandoned: false } : p));
                          }
                        }}
                      >
                        {pending.abandoned ? 'Open the sign-in again' : 'Bring that tab forward'}
                      </Btn>
                      <Btn onClick={() => { ssoWindow.current = null; setPending(null); }}>
                        Stop waiting
                      </Btn>
                    </div>
                  </div>
                )}

                <p className="mt-2.5 text-[12px] leading-[1.6] text-muted">
                  The dashboard uses your sign-in <span className="text-text">once</span>, on the
                  server, to mint the 24-hour <code className="mono text-text">fleet-reader</code>{' '}
                  token — your own credential is never stored, never sent to the browser, and never
                  used to read the cluster afterwards.
                </p>
                <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">
                  Needs the callback below registered as a redirect URI on the identity provider's
                  client, matched as an exact string. If it is not, the provider stops you on{' '}
                  <span className="text-text">its own</span> error page in that tab rather than
                  returning you here — close it and use a token instead. Nothing on this page is
                  lost either way.
                </p>

                {callback.url && (
                  <div className="mt-2.5 border-t border-line pt-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                        Redirect URI to register
                      </span>
                      <button
                        type="button"
                        onClick={() => copyUri(callback.url!)}
                        className="text-[12px] font-medium text-accent-bright hover:underline"
                      >
                        {copied ? '✓ Copied' : 'Copy URI'}
                      </button>
                    </div>
                    <pre className="mono mt-1.5 overflow-x-auto rounded-[6px] border border-line bg-raised px-2.5 py-2 text-[12px] text-text select-all">{callback.url}</pre>
                    <p className="mt-1 text-[12px] text-muted">
                      Copy it exactly — a trailing slash is a different URI. Each host the console
                      runs on needs its own entry.
                    </p>

                    {callback.problem === 'DERIVED_FROM_REQUEST' && (
                      <p className="mt-1.5 flex gap-1.5 text-[12px] leading-[1.6] text-warn">
                        <Dot tone="warn" />
                        <span>
                          Derived from this request, not configured. That is correct for local
                          development and wrong behind a proxy, which rewrites the host — there this
                          would be an internal address the identity provider can never reach back
                          to. Set <code className="mono">FLEET_SSO_CALLBACK_URL</code> on the backend
                          to the console's public https origin, and this line becomes the URI to
                          register.
                        </span>
                      </p>
                    )}
                    {callback.problem === 'CONFIGURED_VALUE_INVALID' && (
                      <p className="mt-1.5 flex gap-1.5 text-[12px] leading-[1.6] text-bad">
                        <Dot tone="bad" />
                        <span>
                          <code className="mono">FLEET_SSO_CALLBACK_URL</code> is set to something
                          that is not an absolute <code className="mono">http</code> or{' '}
                          <code className="mono">https</code> URL, so it was ignored and the line
                          above is a guess. A bare hostname is not enough — include the scheme.
                        </span>
                      </p>
                    )}
                    {callback.problem === 'CONFIGURED_VALUE_INSECURE' && (
                      <p className="mt-1.5 flex gap-1.5 text-[12px] leading-[1.6] text-bad">
                        <Dot tone="bad" />
                        <span>
                          This callback is plain <code className="mono">http</code> on a public host.
                          Identity providers refuse to register that — SAP IAS among them — and where
                          one does not, the authorization code travels in the clear. Point{' '}
                          <code className="mono">FLEET_SSO_CALLBACK_URL</code> at the console's{' '}
                          <code className="mono">https</code> origin instead.
                        </span>
                      </p>
                    )}
                    {callback.configured && callback.secure && (
                      <p className="mt-1.5 flex gap-1.5 text-[12px] leading-[1.6] text-muted">
                        <Dot tone="ok" />
                        <span>
                          Configured on the backend and served over https — this is the exact string
                          to register, not a guess from this request.
                        </span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </Step>

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
                  <Btn onClick={() => void startSso({ ...collision.body, replace: true })} disabled={busy}>
                    {busy ? 'Replacing…' : `Sign in and replace ${collision.clusterId}`}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setCollision(null)} disabled={busy}>
                    Keep the existing cluster
                  </Btn>
                </div>
              </div>
            </div>
          )}

          {/* An attempt that came back refused. Kept distinct from `error` because it describes a
              round trip the operator has already spent a minute on, and because the one that
              matters most — the callback not being registered — is fixed by a person, not by
              retrying. */}
          {ssoOutcome?.state === 'failed' && (
            <div className="p-5">
              <div className="rounded-[6px] border border-bad/40 bg-bad/10 p-4">
                <p className="text-[13px] font-semibold text-bad">
                  <span className="mono">{ssoOutcome.code}</span> — the sign-in did not complete
                </p>
                <p className="mt-1 text-[13px] text-muted">{ssoOutcome.message}</p>
                {ssoOutcome.code === 'OIDC_ISSUER_ERROR' && (
                  <p className="mt-2 text-[13px] text-muted">
                    This is almost always the redirect URI: the identity provider will only call
                    back to an address registered on its client, and this dashboard's is not
                    registered yet. An administrator has to add it. Until then, add the cluster with
                    a service-account token instead — it reaches the same place.
                  </p>
                )}
                {ssoOutcome.code === 'OIDC_FLOW_EXPIRED' && (
                  <p className="mt-2 text-[13px] text-muted">
                    Flows last five minutes and are single-use. Start again.
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <Btn variant="ghost" onClick={() => setSsoOutcome(null)}>Dismiss</Btn>
                  <Btn onClick={() => navigate('/onboard')}>Use a token instead</Btn>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-5">
              <p className="rounded-[6px] border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">
                <span className="font-semibold">
                  {error.code === 'CLIPBOARD_DENIED' ? 'Copying failed' : 'The sign-in could not be started'}
                </span>
                {' — '}
                <span className="mono">{error.code}</span> — {error.message}
              </p>
            </div>
          )}
        </div>

        <DetectedPanel src={src} endpoint={endpoint} caPresent={caPresent}>
          <ul className="space-y-1.5 text-[13px]">
            <Check done={nameValid} label="Cluster named" />
            <Check done={Boolean(endpoint)} label="API server read from the file" />
            <Check done={caPresent} label="Certificate authority present" />
            <Check done={Boolean(issuer)} label="Identity provider found in the file" />
            <Check
              done={false}
              pending={ready}
              label={ready ? 'Sign in to finish' : 'Sign in'}
            />
          </ul>

          {/* No second Connect button. The only way to finish on this page is the sign-in, and it
              lives in step 3 beside the issuer it will send the operator to — a duplicate here
              would put two controls that leave the page in two different places. */}
          <div className="mt-4 flex items-center gap-2">
            <Btn onClick={() => navigate('/onboard')} disabled={busy}>← Token instead</Btn>
            <Btn variant="ghost" onClick={() => navigate('/')} disabled={busy}>Cancel</Btn>
          </div>
          <p className="mt-2 text-[12px] text-muted" aria-live="polite">
            {blocker || (waiting
              ? 'Waiting for the sign-in tab'
              : 'Ready — use Sign in above; the cluster is verified before anything is stored')}
          </p>
        </DetectedPanel>
      </div>
    </div>
  );
}
