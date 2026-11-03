/**
 * Error copy — one professional template for every failure this console can show.
 *
 * The problem this solves: every error surface rendered `CODE` plus the backend's raw sentence.
 * `UNAUTHENTICATED: platformsbx: 401 from /api/v1/nodes` is accurate and useless — it names what
 * happened without saying what it means for what is on screen, who fixes it, or what to do next.
 * Three different people read these messages (an operator on call, a cluster admin, whoever runs
 * this app), and the raw code routes none of them.
 *
 * So every error is explained in the same four parts, and the order is the reading order:
 *
 *   title    plain language, no code, no jargon — what went wrong
 *   meaning  what it means for the data on screen, and explicitly whether anything changed
 *   action   the next concrete step, or an honest statement that there isn't one
 *   detail   the code and the backend's own sentence, verbatim, always kept
 *
 * `detail` is never dropped or summarised. It is what makes a report actionable, and paraphrasing
 * an upstream message is how a UI starts lying about causes it never observed.
 *
 * Two rules the copy here follows, both from the project's data-honesty contract:
 *   - Never assert a cause the backend did not report. An unknown code gets a fallback that says
 *     so, rather than a confident guess that sends someone down the wrong path.
 *   - Never imply a failed read is a zero. Several `meaning` lines say this outright, because a
 *     table showing "none found" under a failed fetch is the exact bug the contract exists for.
 */

/** Which dot the error state shows. `needsReseed` still overrides this to `bad` at the call site. */
export type ErrorTone = 'bad' | 'warn' | 'info';

export type ErrorExplanation = {
  /** Plain-language headline. Never contains the code. */
  title: string;
  /** What this means for the data on screen, including whether anything was changed. */
  meaning: string;
  /** The next concrete step, or why there isn't one. */
  action: string;
  tone: ErrorTone;
  /**
   * False when this console has no specific guidance for the code — the fallback path. Surfaces
   * exist that want to say "unrecognised", and a caller cannot tell from the strings alone.
   */
  known: boolean;
};

type Entry = Omit<ErrorExplanation, 'known'>;

/**
 * Two codes, one situation: the collectors raise `TOO_LARGE`, the transport layer raises
 * `RESPONSE_TOO_LARGE`, and the reader does not care which layer noticed.
 */
const TOO_LARGE: Entry = {
  title: 'The cluster’s response was too large to load safely',
  meaning:
    'The answer exceeded this console’s response cap, so it was discarded rather than half-parsed. No ' +
    'number derived from it would be trustworthy, so none is shown.',
  action: 'Narrow the namespace or the time window and read again.',
  tone: 'warn'
};

/**
 * The credential/reachability family — the four an operator actually hits, and the reason the
 * 401/403 split is preserved all the way from errors.js to here. They demand opposite responses:
 * a 401 means re-seed the token, a 403 means fix RBAC, and no amount of re-seeding helps a 403.
 */
const CLUSTER: Record<string, Entry> = {
  UNAUTHENTICATED: {
    title: 'The cluster rejected this console’s credential',
    meaning:
      'The API server answered 401, so the stored service-account token is no longer accepted and the ' +
      'automatic renewal chain is broken. Nothing could be read from this cluster — the empty figures ' +
      'on this page are missing readings, not zeros.',
    action:
      'Mint a fresh 24-hour token on the cluster and re-onboard it. Where this console can name the exact ' +
      'command, it is shown below.',
    tone: 'bad'
  },
  EXPIRED: {
    title: 'The stored token has expired',
    meaning:
      'This console checked the expiry before sending anything, so no request reached the cluster. The ' +
      'cluster itself is not known to be unhealthy; its credential here simply ran out.',
    action: 'Renew the token from the Credentials tab, or re-onboard the cluster with a new one.',
    tone: 'bad'
  },
  UNSEEDED: {
    title: 'No credential is stored for this cluster',
    meaning:
      'The cluster is registered but has never been given a token, so nothing has been read from it yet. ' +
      'This is the expected state immediately after onboarding a registration without a credential.',
    action: 'Onboard it with a kubeconfig or a pasted fleet-reader token to start reading.',
    tone: 'warn'
  },
  FORBIDDEN: {
    title: 'The credential is valid, but the cluster’s RBAC denies this read',
    meaning:
      'The API server answered 403: the token authenticated correctly and the fleet-reader role is missing ' +
      'a rule for this resource. Replacing the token will not change the answer.',
    action:
      'Add the missing rule to the fleet-reader ClusterRole — `npm run fleet:onboard` re-applies the ' +
      'current one — then reload this page.',
    tone: 'bad'
  },
  UNREACHABLE: {
    title: 'The cluster’s API server could not be reached',
    meaning:
      'The request failed at the network level — DNS, TLS, a refused connection or a timeout — so the API ' +
      'server never answered. This console cannot tell from here whether the cluster is healthy.',
    action:
      'Confirm the API server URL is correct and reachable from this app’s egress path. A missing ' +
      'egress allowlist entry for the cluster host is the usual cause.',
    tone: 'bad'
  },
  RATE_LIMITED: {
    title: 'The cluster’s API server is throttling this console',
    meaning:
      'The API server answered 429 after the built-in retries had already been spent. The credential is ' +
      'fine and the cluster is up; it is refusing the rate, not the request.',
    action: 'Refresh in a moment. If it persists, narrow the namespace filter so each read asks for fewer objects.',
    tone: 'warn'
  },
  UPSTREAM: {
    title: 'The cluster answered, but not in a usable form',
    meaning:
      'The API server returned a body this console could not parse, or a status it does not recognise. What ' +
      'is shown here is incomplete rather than complete-and-empty.',
    action:
      'Refresh once. If it repeats, the API server or an admission webhook in front of it is where to look — ' +
      'quote the detail below.',
    tone: 'bad'
  },
  NOT_FOUND: {
    title: 'That object no longer exists on the cluster',
    meaning:
      'The cluster answered normally and the specific object asked for is not there. A link or bookmark to ' +
      'something since deleted or renamed produces exactly this. Nothing is wrong with the cluster.',
    action: 'Return to the list and pick a current object.',
    tone: 'info'
  },
  TOO_LARGE,
  RESPONSE_TOO_LARGE: TOO_LARGE,
  NOT_RECONCILED: {
    title: 'The controller has not reconciled this object yet',
    meaning:
      'The object exists but its controller has not produced a status, so there is nothing authoritative to ' +
      'report about it. This is normal for seconds after a change and abnormal if it lasts.',
    action: 'Refresh shortly. If the state persists, the owning operator’s controller is where to look.',
    tone: 'warn'
  }
};

/** Authentication and authorization of the person using the console, not of a cluster token. */
const SESSION: Record<string, Entry> = {
  SESSION_LOST: {
    title: 'Your sign-in session has expired',
    meaning:
      'The single sign-on session behind this browser tab is no longer valid, so the request was answered ' +
      'by the login page instead of the fleet API. No cluster was contacted and nothing was changed.',
    action: 'Sign in again. This page reopens where you left it — the view is held in the URL.',
    tone: 'warn'
  },
  MISSING_SCOPE: {
    title: 'This account is not authorized for that change',
    meaning:
      'The request needed the fleet-admin scope and this sign-in does not carry it. Reading the fleet ' +
      'is unaffected; only onboarding, removing and token renewal are gated.',
    action:
      'Ask an administrator to grant the fleet-admin scope in your identity provider, then sign out ' +
      'and in again so the new scope is in your token.',
    tone: 'warn'
  },
  ONBOARD_DISABLED: {
    title: 'Onboarding is turned off in this deployment',
    meaning:
      'This environment runs with cluster onboarding disabled, so the request was refused before anything was ' +
      'written. Existing registrations continue to work.',
    action: 'Enable onboarding for this environment, or add the cluster from an environment where it is on.',
    tone: 'info'
  },
  RENEW_DISABLED: {
    title: 'Token renewal is turned off in this deployment',
    meaning: 'This environment runs with renewal disabled, so no new token was requested and the stored one is untouched.',
    action: 'Renew the credential outside this console and re-onboard the cluster with it.',
    tone: 'info'
  }
};

/**
 * Input the operator just typed or pasted. These are the only errors where the fix is entirely in
 * the reader's hands and needs no cluster knowledge, so the copy stays short and imperative.
 */
const INPUT: Record<string, Entry> = {
  BAD_REQUEST: {
    title: 'The request was missing something required',
    meaning: 'It was refused before anything was read or written. The detail below names the field.',
    action: 'Correct the highlighted field and submit again.',
    tone: 'warn'
  },
  BAD_JSON: {
    title: 'That text is not valid JSON',
    meaning: 'It could not be parsed, so nothing was read from it.',
    action: 'Paste the file again, complete and unedited.',
    tone: 'warn'
  },
  NO_NAME: {
    title: 'A name is required',
    meaning: 'The request identified no object, so there was nothing to look up.',
    action: 'Provide the object’s name and try again.',
    tone: 'warn'
  },
  NO_KUBECONFIG: {
    title: 'No kubeconfig was provided',
    meaning: 'Onboarding needs the cluster’s API server URL and CA, which is what the kubeconfig carries.',
    action: 'Paste or upload the cluster’s kubeconfig, or enter the API server URL and CA by hand.',
    tone: 'warn'
  },
  NO_CREDENTIAL: {
    title: 'No credential was provided',
    meaning:
      'The registration would have been created with no way to read the cluster. It was refused rather than ' +
      'stored half-configured.',
    action: 'Paste a fleet-reader token, or supply a kubeconfig that carries one.',
    tone: 'warn'
  },
  NO_TOKEN: {
    title: 'No token was provided',
    meaning: 'There was no bearer token in the request, so nothing could be stored or used.',
    action: 'Paste the service-account token and submit again.',
    tone: 'warn'
  },
  INVALID_TOKEN: {
    title: 'That is not a usable bearer token',
    meaning:
      'The value was rejected on its shape before any cluster saw it, so nothing was sent anywhere. Its ' +
      'contents are not logged or displayed.',
    action: 'Mint a fresh token with `kubectl create token` and paste it whole, with no line breaks.',
    tone: 'warn'
  },
  UNRESOLVED_IDENTITY: {
    title: 'Your sign-in did not say who you are',
    meaning:
      'The token was valid but carried no logon name or user name, so this console cannot keep your ' +
      'results apart from anyone else’s and refused the request rather than share them.',
    action: 'Sign out and sign in again. If it repeats, ask an administrator to check the identity provider sends a user name.',
    tone: 'warn'
  },
  NO_CA: {
    title: 'No certificate authority was provided',
    meaning:
      'Without the cluster’s CA, the TLS connection to its API server cannot be verified, and this console ' +
      'will not skip that check.',
    action: 'Supply the cluster’s `certificate-authority-data`, which the kubeconfig contains.',
    tone: 'warn'
  },
  BAD_API_URL: {
    title: 'The API server URL could not be parsed',
    meaning: 'It is not a valid URL, so no connection was attempted.',
    action: 'Enter the full URL, scheme included — for example `https://api.example.com`.',
    tone: 'warn'
  },
  BLOCKED_API_URL: {
    title: 'That address is not permitted as an API server',
    meaning:
      'The host is in a link-local range, which is the node’s own instance-metadata endpoint rather than a ' +
      'Kubernetes API server. The request was refused before it was sent.',
    action: 'Enter the cluster’s real API server URL.',
    tone: 'bad'
  },
  CLUSTER_EXISTS: {
    title: 'A cluster is already registered under that id',
    meaning:
      'The existing registration was left exactly as it was. Overwriting it silently would have replaced a ' +
      'working credential with an untested one.',
    action: 'Choose a different id, or re-submit with Replace selected to overwrite it deliberately.',
    tone: 'warn'
  },
  BAKED_CLUSTER: {
    title: 'That registration ships inside the container image',
    meaning:
      'It comes from the image rather than the runtime store, so deleting the record would work until the next ' +
      'pod restart put it straight back.',
    action: 'Remove it from the image’s cluster list and redeploy.',
    tone: 'info'
  },
  UNSUPPORTED_KIND: {
    title: 'This console does not read that kind of object',
    meaning:
      'The kind is not in the resource registry, so there is no declared way to read or render it. Nothing was ' +
      'guessed at.',
    action: 'Open the object in its own tab, or ask for the kind to be added to the registry.',
    tone: 'info'
  },
  UNSUPPORTED_ACTION: {
    title: 'That action is not available in this console',
    meaning:
      'This dashboard is read-only by design: it exposes no control that mutates a cluster resource, and the ' +
      'request was refused before reaching the cluster.',
    action: 'Perform the change with your own cluster access, through kubectl or your cluster’s own console.',
    tone: 'info'
  },
  TEMPLATE_ERROR: {
    title: 'The chart template could not be rendered',
    meaning: 'The release’s stored template failed to render, so no manifest is shown rather than a partial one.',
    action: 'Inspect the release with `helm get manifest`; the detail below names the failure.',
    tone: 'warn'
  }
};

/**
 * The browser-PKCE single sign-on path used to bootstrap a cluster credential. Its failures are
 * mid-flow and time-sensitive, so each one says whether restarting the flow is the answer — and
 * none of them ever quotes a token, a code or a verifier.
 */
const OIDC: Record<string, Entry> = {
  OIDC_NO_CODE: {
    title: 'The sign-in came back without an authorization code',
    meaning: 'The identity provider redirected here with no code to exchange, so no credential was obtained.',
    action: 'Start the sign-in again from the Add cluster page.',
    tone: 'warn'
  },
  OIDC_NO_ID_TOKEN: {
    title: 'The identity provider returned no ID token',
    meaning:
      'The code was exchanged but the response carried no ID token, which is the part a cluster accepts as a ' +
      'credential. Nothing was stored.',
    action:
      'Confirm the client is configured to issue an ID token for the `openid` scope, then start the sign-in again.',
    tone: 'warn'
  },
  OIDC_ISSUER_ERROR: {
    title: 'The identity provider rejected the sign-in',
    meaning: 'The provider answered with an error instead of a credential. Its own message is in the detail below.',
    action: 'Resolve the error the provider reported, then start the sign-in again.',
    tone: 'bad'
  },
  OIDC_FLOW_EXPIRED: {
    title: 'That sign-in attempt took too long',
    meaning:
      'The pending flow expired before the provider redirected back, so it was discarded rather than completed ' +
      'against stale state.',
    action: 'Start the sign-in again and complete it without pausing.',
    tone: 'warn'
  },
  OIDC_FLOW_NOT_YOURS: {
    title: 'That sign-in belongs to a different session',
    meaning:
      'The redirect did not match the flow this browser session started. It was refused, which is what stops ' +
      'one session from completing another’s sign-in.',
    action: 'Start the sign-in again in this tab.',
    tone: 'bad'
  },
  OIDC_HOST_NOT_ALLOWLISTED: {
    title: 'That cluster host is not on the passthrough allowlist',
    meaning:
      'Forwarding a user’s identity to an arbitrary host would send their token somewhere unvetted, so the ' +
      'request was refused before anything was sent.',
    action: 'Add the cluster host to the passthrough allowlist for this environment, or onboard with a token instead.',
    tone: 'bad'
  },
  OIDC_ISSUER_NOT_ALLOWLISTED: {
    title: 'That identity provider is not on the allowlist',
    meaning: 'The issuer is not one this environment trusts, so no sign-in was started against it.',
    action: 'Use an allowlisted issuer, or have this one added for the environment.',
    tone: 'bad'
  },
  OIDC_BOOTSTRAP_FAILED: {
    title: 'The credential sign-in did not complete',
    meaning: 'The flow failed part-way and nothing was stored. The registration is unchanged.',
    action: 'Start the sign-in again, or onboard the cluster with a pasted token instead.',
    tone: 'bad'
  }
};

const EXPLANATIONS: Record<string, Entry> = { ...CLUSTER, ...SESSION, ...INPUT, ...OIDC };

/**
 * What to say about a code this console has never heard of.
 *
 * Deliberately generic: inventing a cause for an unrecognised code is worse than admitting the gap,
 * because a plausible wrong explanation sends whoever is on call down the wrong path and they have
 * no way to tell. The one thing it does assert is the thing that is always true of a fleet error —
 * the read did not complete, so nothing on screen derived from it is a real zero.
 */
function fallback(): Entry {
  return {
    title: 'This read did not complete',
    meaning:
      'The fleet API reported a failure this console has no specific guidance for. Whatever is missing from ' +
      'this page is an unread value, not a measured zero, and nothing was changed.',
    action:
      'Refresh once. If it repeats, quote the code and message below — they are exactly what the backend ' +
      'reported — to whoever operates the fleet API.',
    tone: 'bad'
  };
}

/**
 * Explain one error code in the four-part template.
 *
 * Takes the code alone: the backend's message is rendered verbatim as `detail` by the caller and is
 * deliberately not parsed here. Sniffing an upstream sentence for keywords to pick better copy is
 * how a UI ends up confidently explaining a cause nobody observed.
 */
export function explainError(code: string | undefined | null): ErrorExplanation {
  const entry = code ? EXPLANATIONS[code] : undefined;
  return entry ? { ...entry, known: true } : { ...fallback(), known: false };
}

/** Every code with tailored copy. Exported for the test that keeps this file honest. */
export function explainedCodes(): string[] {
  return Object.keys(EXPLANATIONS).sort();
}
