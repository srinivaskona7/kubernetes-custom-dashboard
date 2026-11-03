# CLAUDE.md

## Project Overview

This is a **GitHub template repository** for BTP platform engineers to scaffold full-stack internal web applications. It ships as a working app with placeholder "Books" sample data (books, authors, genres), demonstrating all patterns end-to-end. Engineers clone it, run `./scripts/setup.sh <app-name>`, and start building.

**Derived from:** `btp-platform-ias-admin` — the IAS Admin tool's architecture, design system, and deployment patterns were generalized into this template.

## Tech Stack

- **Frontend:** React 18 + Vite 6 (JSX, no TypeScript)
- **Backend:** Express 4 on Node.js 20 (ES modules, top-level await)
- **Styling:** Ant Design (`antd`) for components; small `src/index.css` shell stylesheet with CSS custom properties
- **Logging:** Pino with pino-pretty
- **Auth:** Shield OIDC (JWT verification via `jose`, group membership check)
- **Database:** SQLite via `better-sqlite3`, persisted on a ReadWriteOnce PVC in K8s
- **Secrets:** Whisper mTLS client (with local JSON fallback in dev)
- **Deployment:** Helm chart on EKS, Docker multi-stage build (Apple UBI9), ECR registry
- **CI/CD:** Rio pipeline (`rio.yml`) — PR build, Docker publish, Helm deploy
- **Observability:** Splunk sidecar forwarder with NetworkPolicy egress rules

## Architecture

```
Browser → Shield VIP → NLB → K8s ClusterIP → Express (port 3001)
                                                 ├── /api/health      ({ok: true})
                                                 ├── /api/books        (from SQLite)
                                                 ├── /api/authors      (derived from books)
                                                 ├── /api/genres       (derived from books)
                                                 └── /api/status       (Narrative cert at /tls: CN, APRN, expiry)
                                              Vite serves dist/ in production
```

**Data:** `server/db.js` `loadDb()` opens SQLite at `DB_PATH` (default `./data/app.db`; `/app/data/app.db` on the PVC in K8s), creates the schema, and seeds the `books` table from `config/config.local.json` only when it is empty. Routes receive the `db` handle and call query helpers in `db.js`.

**Persistence:** `chart/templates/pvc.yaml` is a ReadWriteOnce PVC mounted at `/app/data`. The Deployment **must** use `strategy.type: Recreate` with a single replica — the chart refuses to render RollingUpdate while persistence is on (Multi-Attach deadlock), or `persistence.enabled=false` without `persistence.allowEphemeral=true`. Upgrading a Deployment first created as RollingUpdate fails (`spec.strategy.rollingUpdate: Forbidden`) because Helm cannot remove the server-defaulted field; `scripts/helm-deploy.sh` strips it with a `kubectl patch` preflight before `helm upgrade`. Guarded by `server/__tests__/chart.test.js`.

**Config loading:** `server/config.js` exposes two loaders. `loadBooks()` reads `config/config.local.json` and is used only as the DB seed source. `loadWhisper()` is best-effort: it tries Whisper via mTLS, logs a `warn` on any failure, and returns `null`. The result is stashed in `app.locals.whisper` for any consumer to use.

**Auth flow:** `server/middleware/shieldAuth.js` reads JWT from `shield-oidc-id` header or `Authorization: Bearer`, verifies against JWKS, checks group membership against `ALLOWED_GROUPS`. Bypassed in dev. Health endpoint always passes.

## Key Conventions

- **Route pattern:** Factory functions receiving `db` — see `server/routes/books.js`
- **Frontend data fetching:** `useApi(path)` hook returning `{data, loading, error}` with abort
- **UI library:** Ant Design (`antd`) on a fixed header + sectioned sidebar shell, react-router for pages
- **Styling:** A small `src/index.css` (~110 lines) for shell layout; Antd handles components
- **No TypeScript, no linter** — intentionally minimal tooling. Vitest is used for server-side unit tests (see Testing).
- **ES modules throughout** — `"type": "module"` in package.json, `.js` extensions in imports

## Template System

`template.config.json` holds all project-specific values. `scripts/setup.sh <app-name>` reads it, derives new values, and does a global find-and-replace across all files.

Key placeholder values that get replaced:
- `platform-btp-kyma-fleet-dashboard` — package name, identifiers
- `btp-kyma-fleet-dashboard` — K8s namespace, ECR repo, Helm release, Narrative name
- `/btp-kyma-fleet-dashboard/` — URL base path
- `btp-kyma-fleet-dashboard-prod` / `btp-kyma-fleet-dashboard-non-prods` — Whisper secret names
- `ist-btp-platform-btp-kyma-fleet-dashboard` — Rio project name, badge URLs
- `btp_kyma_fleet_dashboard` — Splunk sourcetype

After setup, both `template.config.json` and `scripts/setup.sh` are deleted.

## First Deploy

The Rio pipeline auto-creates the ECR repository (in `app-build`) and K8s namespace (in `app-deploy`) if they don't exist. No manual infrastructure setup is required for the first run.

### Manual one-time step: install the NarrativeIssuer

The Narrative CSI driver itself is pre-installed cluster-wide on `dev-slm-datahub`, but each namespace needs its own `NarrativeIssuer` CRD before pods can mount `/tls`. **This is the only step the Rio pipeline does NOT do for you** — apply it manually, **with admin kubectl context**, once per namespace:

```bash
# Switch to an admin AWS profile / kubectl context first
# (a non-admin role cannot create NarrativeIssuer CRDs)
kubectl apply -n <namespace> -f scripts/narrative-issuer.yaml

# Verify
kubectl get narrativeissuer -n <namespace>
```

If you skip this, the pod will sit in `ContainerCreating` with `MountVolume.SetUp failed for volume "tls"` — either `driver name narrative.apple.com not found` (driver pod hasn't initialized yet on a fresh node — self-resolves) or `request has not yet been approved by approval plugin` (no NarrativeIssuer in this namespace).

## Testing

- **Framework:** Vitest (`npm test` / `vitest run`)
- **Config:** `vitest.config.js` — node environment, includes `server/**/__tests__/**/*.test.js`
- **Test location:** co-located under `server/**/__tests__/` alongside the modules they cover (e.g. `server/__tests__/config.test.js`, `db.test.js`, `chart.test.js`)
- **Coverage requirement:** every new server-side function must have a corresponding test file. Prefer extracting pure functions from I/O (see `validateBooks` in `server/config.js`) so they can be tested without touching the filesystem or network.
- **CI:** `npm test` runs in both `pr-build` and `app-build` steps in `rio.yml` — failing tests block merge and deploy

## Branch and PR Workflow

- **Never commit directly to `main`** — always create a feature branch and open a PR
- Branch naming: `<type>/<short-description>` e.g. `feat/add-export`, `fix/auth-middleware`
- After opening a PR or pushing major changes, post `@devx-ai /review` as a PR comment to trigger automated review
- When review comments arrive: respond to each inline thread with `resolved` or `deferred`, fix anything that needs fixing, and resolve the thread
- Push all fixes before posting replies so cited commit hashes exist on the remote

## Deferred Work

Anything deferred during design or review — features to build later, improvements to revisit, out-of-scope ideas — must be filed as a GitHub issue on this repo. Do not leave deferred items only in comments, specs, or PR threads. Use `gh issue create --title "..." --body "..."` immediately when deferring.

## Chrome Validation

When the Chrome browser agent takes screenshots during UI validation, delete them from the repo root immediately after — before or at the next commit. They are temporary artifacts and must not be committed.

```bash
find . -maxdepth 2 -name "*.png" -o -name "*.jpg" | grep -v node_modules | grep -v .git
```

## Development

```bash
npm run dev    # Vite (5173) + Express (3001) concurrently
npm run build  # Vite production build → dist/
npm run deploy # build → ECR push → Helm upgrade
```

Vite proxies `/api/*` to `localhost:3001` in dev. Shield auth and Whisper are bypassed locally.

**Apple corporate CA certs:** The `start` script sets `NODE_EXTRA_CA_CERTS=./node_modules/@apple/node-corp-certs/certs.pem`. This is required for Node.js to trust Apple's internal root CA when making HTTPS requests to Apple-internal services (Whisper, Shield JWKS, internal APIs). Without it, TLS handshakes to those services fail with certificate errors in production. The `@apple/node-corp-certs` package is pinned in `dependencies` — do not remove it.

## File Organization

```
server/
  index.js           — Express app, config loading, route registration
  db.js              — SQLite: loadDb(), schema, seed, query helpers
  config.js          — loadBooks() (DB seed source) + loadWhisper() (best-effort)
  logger.js          — Pino singleton
  lib/whisper.js     — mTLS Whisper client (kept for future use)
  middleware/shieldAuth.js — JWT auth + group check via ALLOWED_GROUPS
  routes/books.js    — GET /api/books, GET /api/books/:id
  routes/authors.js  — GET /api/authors (aggregated from books table)
  routes/genres.js   — GET /api/genres (aggregated from books table)
  routes/status.js   — GET /api/status (Narrative identity status)
  lib/certStatus.js  — reads /tls cert/key/CA: CN, APRNs, validity, key match
  __tests__/config.test.js — validateBooks()
  __tests__/db.test.js     — schema, seed, queries, loadDb()
  __tests__/chart.test.js  — PVC / Recreate deploy-safety guards
  __tests__/certStatus.test.js — cert parsing, state, readCertStatus()
  __tests__/status.test.js     — /api/status route

src/
  main.jsx           — ConfigProvider + ThemeProvider wrapping App
  App.jsx            — Header + sidebar + react-router routes
  index.css          — Shell layout styles (~110 lines)
  api.js             — api(path) helper respecting Vite BASE_URL
  components/
    PageHeader.jsx   — Shared title/subtitle component
  hooks/
    useTheme.jsx     — Light/dark/system mode + localStorage persistence
    useApi.js        — fetch + abort + {data, loading, error}
  pages/
    AllBooks.jsx     — Antd Table over /api/books
    Authors.jsx      — Antd Table over /api/authors
    Genres.jsx       — Antd Table over /api/genres
    Status.jsx       — Narrative certificate status over /api/status
    NotFound.jsx     — Simple 404

chart/               — Helm chart (SQLite PVC, Narrative CSI inline, Splunk sidecar, HPA, NetworkPolicy)
scripts/setup.sh             — One-shot template initialization
scripts/narrative-issuer.yaml — Manual one-time NarrativeIssuer CRD per namespace
vitest.config.js     — Vitest config (node env, server/**/__tests__)
rio.yml              — CI/CD pipeline (pr-build, app-build, app-deploy)
```
