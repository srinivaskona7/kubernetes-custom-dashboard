/**
 * Everything the two onboarding pages both need.
 *
 * There are two of them because they ask for different things: `/onboard` wants a kubeconfig and
 * a service-account token, and `/onboard/advanced` wants an exec-OIDC kubeconfig and a sign-in.
 * What they share is everything *around* the credential — naming the cluster, reading the file,
 * and the vocabulary for describing what the server found in it — and a second copy of any of
 * that is a second set of rules that drifts. The id-slug rule in particular has to match the
 * server's character for character, and matching it twice is how a page starts previewing a URL
 * the fleet will not use.
 */
import type { KubeconfigDescription } from '../../api';

/** Anything larger is not a kubeconfig, and the server refuses it too. */
export const MAX_FILE_BYTES = 512 * 1024;

/** Long enough that typing a context name does not fire a request per keystroke. */
export const DESCRIBE_DEBOUNCE_MS = 350;

export type SourceMode = 'upload' | 'paste';

/**
 * A credentials file that is not a kubeconfig: the JSON `npm run fleet:input` writes.
 * It already carries the three values the token path needs, so it skips describe entirely.
 */
export type DirectCredentials = { apiUrl: string; caData: string; token: string; name: string };

export const ENVIRONMENTS = ['sbx', 'dev', 'uat', 'prod'] as const;
export type Env = (typeof ENVIRONMENTS)[number];

/**
 * The environment is *suggested* from the name and then shown in a control the operator can
 * change. It used to be inferred silently at submit time, which meant a cluster called
 * "production-eu" was filed as sbx with nothing on screen saying so.
 */
export function suggestEnv(name: string): Env {
  const n = name.toLowerCase();
  if (n.includes('prod')) return 'prod';
  if (n.includes('uat')) return 'uat';
  if (n.includes('dev')) return 'dev';
  return 'sbx';
}

/** The server's rule, mirrored only to preview the id the URL will use. */
export function clusterIdOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

export function isJwt(token: string): boolean {
  return token.trim().split('.').length === 3 && token.trim().length > 40;
}

export const CREDENTIAL_LABEL: Record<KubeconfigDescription['credential'], string> = {
  token: 'static service-account token',
  'exec-oidc': 'OIDC login helper (kubectl-oidc_login)',
  exec: 'exec plugin',
  'auth-provider': 'auth-provider plugin',
  'client-certificate': 'client certificate',
  none: 'no credential'
};

// ------------------------------------------------------------------- the SSO round trip

/** What a finished SSO round trip reports back. Never a credential — an outcome and an id. */
export type SsoOutcome =
  | { state: 'connected'; clusterId: string }
  | { state: 'failed'; code: string; message: string };

/**
 * The same-origin channel the sign-in tab uses to hand its outcome to the console tab.
 *
 * `BroadcastChannel` rather than `window.opener.postMessage`: the opener reference does not
 * survive every browser's cross-origin round trip through the identity provider, and a channel
 * needs no reference at all. Only an outcome word and a cluster id ever travel on it.
 */
export const SSO_CHANNEL = 'kyma-fleet:sso';

/**
 * A fixed window name, so clicking "Sign in" twice re-uses the one sign-in tab instead of
 * stacking up tabs that are all racing for the same single-use flow.
 */
export const SSO_WINDOW = 'kyma-fleet-sso';

/**
 * True when this document is the tab we opened for the sign-in, rather than the console.
 *
 * Keyed on the window name we set in `window.open`, which survives the cross-origin round trip
 * through the identity provider (verified in Chrome). Deliberately *not* also keyed on
 * `window.opener`: that reference is severed by some navigations, and the console tab never
 * carries this name, so the name alone cannot misfire on the tab holding the operator's work.
 */
export function isSignInTab(): boolean {
  try {
    return window.name === SSO_WINDOW;
  } catch {
    return false; // treat anything unreadable as the console tab and stay put
  }
}

/** Wall-clock time only: the deadline is minutes away, so the date would be noise. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
