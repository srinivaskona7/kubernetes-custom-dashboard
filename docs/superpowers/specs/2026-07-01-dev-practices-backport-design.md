# Dev Practices Backport — Design

**Date:** 2026-07-01
**Status:** Approved
**Target repo:** `BTP-Platform/platform-foundation-btp-kyma-fleet-dashboard`
**Source:** `platform-foundation-edge-dashboard` (working conventions developed while building the Shield VIP dashboard)

## Goal

Backport the **working conventions, testing infrastructure, and a latent runtime fix** developed in `edge-dashboard` into the canonical template. The 2026-06-23 backport moved architecture (CSI/chart/Rio); this one moves the "how we work" layer and a real prod bug fix. Everything here is generic and architecture-agnostic.

## What does NOT get backported

- App-specific Shield/VIP features, diff utilities, `shieldClient`/`shieldCache` and their tests.
- The UI-architecture divergence (Antd + react-router vs hand-rolled CSS). Explicitly out of scope.

## Changes — one PR, branch `chore/backport-dev-practices`

### 1. CLAUDE.md working conventions

Add the four sections btp-kyma-fleet-dashboard's CLAUDE.md lacks, ported from edge-dashboard:

- **Testing** — Vitest (`npm test` / `vitest run`), config includes `server/**/__tests__/**/*.test.js`, co-located tests, "every new server-side function must have a corresponding test," `npm test` runs in `pr-build` and `app-build`. Also flip the "no test framework" note in Key Conventions to reflect Vitest.
- **Branch and PR Workflow** — never commit to `main`; branch as `<type>/<short-description>`; post `@devx-ai /review` after opening a PR or major push; respond `resolved`/`deferred` to inline threads and resolve them; push fixes before replying so cited hashes exist.
- **Deferred Work** — anything deferred must be filed as a GitHub issue immediately (`gh issue create`), not left in specs/comments/PR threads.
- **Chrome Validation** — delete screenshots from the repo root before/at the next commit; never commit them.

Also extend the existing **Development** section with the `NODE_EXTRA_CA_CERTS` explanation (ties to change 3): the `start` script sets it so Node trusts Apple's internal root CA for HTTPS to Whisper/Shield JWKS; the `@apple/node-corp-certs` package is pinned and must not be removed.

### 2. Testing infrastructure + CI wiring

- `package.json`: add `vitest ^4` to `devDependencies`; add `"test": "vitest run"` to scripts.
- New `vitest.config.js`: node environment, include `server/**/__tests__/**/*.test.js`.
- Refactor `server/config.js`: extract the inline validation in `loadBooks()` into an exported pure `validateBooks(books)` and call it from `loadBooks()`. Behavior and error messages unchanged.
- New `server/__tests__/config.test.js`: a working sample test covering `validateBooks` — valid books pass; non-array/empty `books` throws `non-empty "books" array`; a book missing `id`/`title`/`author`/`genre` throws `missing required fields`. This proves the harness and models the "extract testable functions + co-locate tests" practice.
- `rio.yml`: insert `- npm test` between `npm ci` and `npm run build` in both `pr-build` and `app-build`.

### 3. CA-certs runtime fix (latent prod bug)

`package.json` `start` script:

```
NODE_EXTRA_CA_CERTS=./node_modules/@apple/node-corp-certs/certs.pem NODE_ENV=production node server/index.js
```

Without this, a cloned app crash-loops on TLS handshakes to Apple-internal HTTPS in production. `@apple/node-corp-certs` is already in `dependencies`, so no dependency change is needed.

### 4. Claude harness hygiene

`.gitignore`: add `.claude/settings.local.json` (machine-local permission grants — should not be committed). `.claude/settings.json` already matches edge-dashboard; no change.

## Verification

1. `npm install` pulls in `vitest`.
2. `npm test` — sample test green.
3. `npm run build` succeeds.
4. `git grep NODE_EXTRA_CA_CERTS package.json` confirms the start-script fix.
5. `rio.yml` shows `npm test` in `pr-build` and `app-build`.
6. `loadBooks()` behavior unchanged (same validation errors as before the extraction).

## Out of scope

- Reconciling the UI architecture — on `main`, code (Antd + react-router + Books) and docs already agree, so there is nothing to reconcile.
- Adding frontend tests or a browser test harness.
- Any change to the Shield/Whisper/Narrative runtime behavior beyond the CA-certs env var.
