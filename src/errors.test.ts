import { describe, expect, test } from 'vitest';
import { explainError, explainedCodes } from './errors';

/**
 * The error template is copy, and copy rots differently from code: nothing breaks when a sentence
 * starts asserting something false. These tests check the properties the template exists to hold,
 * not the wording — a reword should stay green, a dishonest reword should not.
 */

/** Every code the backend can put on the wire, from a grep of `code: '…'` across srv/fleet. */
const BACKEND_CODES = [
  'AUDIT_DISABLED',
  'AUDIT_NEVER_RAN',
  'AUDIT_NOT_READY',
  'AUDIT_STALE',
  'BAD_API_URL',
  'BAD_JSON',
  'BAD_REQUEST',
  'BAKED_CLUSTER',
  'BLOCKED_API_URL',
  'CLUSTER_EXISTS',
  'CONSTRAINTS_UNREADABLE',
  'DRY_RUN',
  'EMPTY_NAMESPACE_SCOPE',
  'EXPIRED',
  'FORBIDDEN',
  'INVALID_REVISION',
  'INVALID_TOKEN',
  'MISSING_SCOPE',
  'NO_CA',
  'NO_CONSTRAINT_INSTANCES',
  'NO_CREDENTIAL',
  'NO_KUBECONFIG',
  'NO_NAME',
  'NO_TARGET_KINDS',
  'NO_TOKEN',
  'NOT_ENFORCED_BY_PODS',
  'NOT_FOUND',
  'NOT_RECONCILED',
  'OIDC_BOOTSTRAP_FAILED',
  'OIDC_FLOW_EXPIRED',
  'OIDC_FLOW_NOT_YOURS',
  'OIDC_HOST_NOT_ALLOWLISTED',
  'OIDC_ISSUER_ERROR',
  'OIDC_ISSUER_NOT_ALLOWLISTED',
  'OIDC_NO_CODE',
  'OIDC_NO_ID_TOKEN',
  'ONBOARD_DISABLED',
  'RATE_LIMITED',
  'RENEW_DISABLED',
  'RESPONSE_TOO_LARGE',
  'TEMPLATE_ERROR',
  'TOO_LARGE',
  'UNAUTHENTICATED',
  'UNREACHABLE',
  'UNRESOLVED_IDENTITY',
  'UNSEEDED',
  'UNSUPPORTED_ACTION',
  'UNSUPPORTED_KIND',
  'UPSTREAM',
  'WEBHOOK_INACTIVE'
];

/**
 * The codes that legitimately have no tailored copy: they never reach an error surface.
 *
 * The AUDIT_*, DRY_RUN, NOT_ENFORCED_BY_PODS and NO_* policy codes are *capability* reasons on the
 * OPA payload — they explain why a section is empty through the capability notice, and never arrive
 * as an `error.code`. Listing them explicitly is what keeps this test meaningful: a genuinely new
 * failure code shows up as a missing explanation rather than disappearing into a blanket allowance.
 */
const NOT_AN_ERROR_SURFACE = new Set([
  'AUDIT_DISABLED',
  'AUDIT_NEVER_RAN',
  'AUDIT_NOT_READY',
  'AUDIT_STALE',
  'CONSTRAINTS_UNREADABLE',
  'DRY_RUN',
  'EMPTY_NAMESPACE_SCOPE',
  'INVALID_REVISION',
  'NO_CONSTRAINT_INSTANCES',
  'NO_TARGET_KINDS',
  'NOT_ENFORCED_BY_PODS',
  'WEBHOOK_INACTIVE'
]);

describe('coverage', () => {
  test('every backend code that can reach an error surface has tailored copy', () => {
    const missing = BACKEND_CODES.filter(c => !NOT_AN_ERROR_SURFACE.has(c)).filter(c => !explainError(c).known);
    expect(missing, `add these to errors.ts, or to NOT_AN_ERROR_SURFACE with the reason`).toEqual([]);
  });

  test('the client-side session code is explained', () => {
    // SESSION_LOST is minted in api.ts, not by the backend, and is the single most-seen failure on
    // an SSO-protected host — an approuter session lapse answers with login HTML at status 200.
    expect(explainError('SESSION_LOST').known).toBe(true);
  });

  test('no explanation exists for a code nothing emits', () => {
    // Dead copy is a maintenance trap: it reads as coverage without ever being shown.
    const emitted = new Set([...BACKEND_CODES, 'SESSION_LOST']);
    const orphans = explainedCodes().filter(c => !emitted.has(c));
    expect(orphans, 'these have copy but no emitter — delete them or fix the code name').toEqual([]);
  });
});

describe('the template holds its shape', () => {
  const codes = [...explainedCodes(), 'A_CODE_THAT_DOES_NOT_EXIST', ''];

  test.each(codes)('%s fills all three prose parts', code => {
    const e = explainError(code);
    for (const [part, text] of Object.entries({ title: e.title, meaning: e.meaning, action: e.action })) {
      expect(text.trim().length, `${code}: ${part} is empty`).toBeGreaterThan(0);
    }
    // A title long enough to wrap defeats the point of a headline; the prose lines are allowed to
    // be paragraphs. 72 is the widest current title plus room, measured, not guessed.
    expect(e.title.length, `${code}: title is too long to read as a headline`).toBeLessThanOrEqual(72);
    expect(['bad', 'warn', 'info']).toContain(e.tone);
  });

  test.each(codes)('%s never puts the raw code in the title', code => {
    // The title is the plain-language half. A code in it means the reader is back to decoding
    // SCREAMING_SNAKE_CASE, which is what this module replaced.
    expect(explainError(code).title).not.toMatch(/[A-Z]{3,}_[A-Z]/);
  });

  test.each(codes)('%s gives the reader something to do', code => {
    // Not a length check on prose for its own sake: an `action` that says nothing leaves the
    // operator exactly where the raw code did.
    expect(explainError(code).action.trim().length).toBeGreaterThan(20);
  });
});

describe('honesty', () => {
  test('an unknown code admits the gap instead of inventing a cause', () => {
    const e = explainError('SOMETHING_NOBODY_HAS_SEEN');
    expect(e.known).toBe(false);
    expect(e.meaning).toMatch(/no specific guidance/i);
    // The one thing always true of a fleet error, and the project's data-honesty rule: a failed
    // read is not a measured zero.
    expect(e.meaning).toMatch(/not a measured zero/i);
  });

  test('a missing code behaves like an unknown one', () => {
    for (const bad of [undefined, null, '']) {
      expect(explainError(bad as string | undefined | null).known).toBe(false);
    }
  });

  test('no copy promises a mutation this console cannot perform', () => {
    // The read-only invariant reaches the copy too: telling an operator to "restart the pod from
    // here" would describe a control that deliberately does not exist.
    const forbidden = /\b(restart|scale|delete|patch|apply|cordon|drain|rollout) (it|this|the pod|the deployment) (here|from here)\b/i;
    for (const code of explainedCodes()) {
      const e = explainError(code);
      expect(`${e.meaning} ${e.action}`, `${code} suggests an action this console does not offer`).not.toMatch(forbidden);
    }
  });

  test('the 401 and 403 explanations stay distinct', () => {
    // They demand opposite responses, measured against a live cluster: 401 means re-seed the
    // token, 403 means the token is fine and RBAC is short a rule. Collapsing them into one
    // "auth error" sends whoever is on call down the wrong path.
    const unauthenticated = explainError('UNAUTHENTICATED');
    const forbidden = explainError('FORBIDDEN');
    expect(unauthenticated.title).not.toBe(forbidden.title);
    expect(unauthenticated.action).toMatch(/token/i);
    expect(forbidden.action).toMatch(/ClusterRole|RBAC|rule/i);
    expect(forbidden.meaning).toMatch(/will not/i);
  });

  test('FORBIDDEN does not tell the reader to replace the token', () => {
    // The specific wrong path. It has to be ruled out positively, because "check the credential"
    // is the reflex sentence a reword would reach for.
    expect(explainError('FORBIDDEN').action).not.toMatch(/mint|re-?onboard|renew/i);
  });
});
