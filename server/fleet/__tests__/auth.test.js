/**
 * Fleet authentication sits behind shieldAuth, which has already verified the JWT and the
 * ALLOWED_GROUPS check. What is left to get wrong, and what these tests pin, is the mapping
 * from that identity onto the fleet's user shape:
 *
 *   - a caller with no identity is refused, never cached under a placeholder name;
 *   - admin is membership of FLEET_ADMIN_GROUPS and nothing else, and an unset list means
 *     nobody is admin (fail closed);
 *   - the local-development identity is admin, and is only used when auth is disabled.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import _auth from '../auth.js';
const { createAuth, parseGroups, identityOf, SCOPE } = _auth;

/** Runs the middleware over a fake request and reports what it did. */
function run(mw, user) {
  const req = user === undefined ? {} : { user };
  let status = null;
  let body = null;
  let called = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  mw(req, res, () => { called = true; });
  return { req, status, body, called };
}

test('parseGroups keeps numeric ids, drops the rest and deduplicates', () => {
  assert.deepStrictEqual(parseGroups('100, 200,abc,,100'), [100, 200]);
  assert.deepStrictEqual(parseGroups(''), []);
  assert.deepStrictEqual(parseGroups(undefined), []);
});

test('identityOf returns the email, or null rather than a placeholder', () => {
  assert.strictEqual(identityOf({ email: 'alice@example.com' }), 'alice@example.com');
  assert.strictEqual(identityOf({}), null);
  assert.strictEqual(identityOf({ email: '' }), null);
  assert.strictEqual(identityOf(undefined), null);
});

test('a caller with no identity is refused with UNRESOLVED_IDENTITY', () => {
  const out = run(createAuth({ env: {} }), undefined);
  assert.strictEqual(out.called, false);
  assert.strictEqual(out.status, 401);
  assert.strictEqual(out.body.code, 'UNRESOLVED_IDENTITY');
});

test('a member of FLEET_ADMIN_GROUPS carries the admin scope', () => {
  const out = run(createAuth({ env: { FLEET_ADMIN_GROUPS: '7,8' } }), { email: 'a@x.com', groups: [1, 8] });
  assert.strictEqual(out.called, true);
  assert.deepStrictEqual(out.req.user, { id: 'a@x.com', email: 'a@x.com', scopes: [SCOPE] });
});

test('an allowed user outside FLEET_ADMIN_GROUPS reads but does not administer', () => {
  const out = run(createAuth({ env: { FLEET_ADMIN_GROUPS: '7' } }), { email: 'b@x.com', groups: [1] });
  assert.strictEqual(out.called, true);
  assert.deepStrictEqual(out.req.user.scopes, []);
});

test('with FLEET_ADMIN_GROUPS unset, ALLOWED_GROUPS grants admin scope; when both are unset nobody is an admin', () => {
  const out = run(createAuth({ env: {} }), { email: 'c@x.com', groups: [1, 7] });
  assert.deepStrictEqual(out.req.user.scopes, []);
  const viaAllowed = run(createAuth({ env: { ALLOWED_GROUPS: '7' } }), { email: 'c@x.com', groups: [1, 7] });
  assert.deepStrictEqual(viaAllowed.req.user.scopes, [SCOPE]);
});

test('the shield groups list is not copied onto the fleet user', () => {
  const out = run(createAuth({ env: { FLEET_ADMIN_GROUPS: '1' } }), { email: 'd@x.com', groups: [1, 2, 3] });
  assert.strictEqual('groups' in out.req.user, false);
});

test('disabled auth is the local development admin', () => {
  const out = run(createAuth({ disabled: true }), undefined);
  assert.strictEqual(out.called, true);
  assert.deepStrictEqual(out.req.user, { id: 'local-dev', name: 'local development', scopes: [SCOPE] });
});
