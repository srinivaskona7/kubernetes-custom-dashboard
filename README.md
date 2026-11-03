[![build](https://badges.pie.apple.com/badges/rio?p=ist-btp-platform-btp-kyma-fleet-dashboard&s=ist-btp-platform-btp-kyma-fleet-dashboard-app-build&l=build)](https://cloud.apple.com/dev/rio/projects/ist-btp-platform-btp-kyma-fleet-dashboard?pageIndex=0)
[![deploy](https://badges.pie.apple.com/badges/rio?p=ist-btp-platform-btp-kyma-fleet-dashboard&s=ist-btp-platform-btp-kyma-fleet-dashboard-app-deploy&l=deploy)](https://cloud.apple.com/dev/rio/projects/ist-btp-platform-btp-kyma-fleet-dashboard?pageIndex=0)

# Platform Foundation Btp Kyma Fleet Dashboard

A production-ready starter for BTP Platform teams building internal web applications on Apple infrastructure. It includes a React + Vite frontend with dark/light theme support, an Express backend with Pino structured logging, Shield OIDC authentication, Whisper secret management, and a Helm chart pre-configured for Narrative mTLS, Splunk log forwarding, and network policies. Clone it, run the setup script, and start building your app.

## Quick Start

```bash
# 1. Create your project from the template
gh repo create my-app-name --template <template-repo-url>
cd my-app-name

# 2. Run the setup script to rename everything to your app
./scripts/setup.sh my-app-name

# 3. Install dependencies
npm install

# 4. Start the dev server (Express + Vite)
npm run dev

# 5. Open the app
open http://localhost:5173
```

## First-Time Infrastructure Setup

The Rio pipeline handles ECR repository and K8s namespace creation automatically on the first run. If you prefer to set them up manually or need to debug a failed first deploy:

```bash
# 1. Create the ECR repository (one-time)
aws ecr create-repository \
  --repository-name <app-name> \
  --region us-west-2 \
  --registry-id 637248970961

# 2. Create the K8s namespace (one-time)
kubectl create namespace <app-name>
```

The pipeline's `app-build` stage checks for the ECR repo before pushing, and `app-deploy` checks for the namespace before running Helm — both create them if missing.

## What's Included

- **React 18 + Vite frontend** with dark/light theme toggle and resizable sidebar
- **Express backend** with Pino structured logging (JSON in prod, pretty in dev)
- **Shield OIDC authentication** with JWT validation and group membership checks
- **Whisper secret management** via mTLS (with local config fallback for development)
- **Helm chart** with Narrative CSI volume, Splunk sidecar, network policies, and HPA
- **Docker multi-stage build** on Apple UBI9 base image
- **One-command deploy pipeline** (build, ECR push, Helm upgrade)
- **Rio CI/CD pipeline** with PR builds, Docker publish to ECR, and auto-deploy to EKS

## Project Structure

```
├── chart/                    # Helm chart
│   ├── templates/
│   │   ├── deployment.yaml
│   │   ├── ingress.yaml
│   │   ├── narrative-issuer.yaml
│   │   ├── service.yaml
│   │   ├── serviceaccount.yaml
│   │   ├── hpa.yaml
│   │   ├── splunk-configmap.yaml
│   │   └── splunk-egress.yaml
│   └── values.yaml
├── config/
│   └── config.local.json     # Seed data for the SQLite books table
├── docs/                     # Design docs and plans
├── scripts/
│   ├── setup.sh              # One-time project rename script
│   ├── generate-narrative-cert.cjs
│   └── configure_aws_cli.sh  # AWS CLI setup for Rio pipelines
├── server/
│   ├── index.js              # Express entry point
│   ├── config.js             # Config loader (Whisper → local fallback)
│   ├── logger.js             # Pino logger
│   ├── lib/
│   │   ├── api.js            # Upstream API helper
│   │   └── whisper.js        # Whisper secret client
│   ├── middleware/
│   │   └── shieldAuth.js     # Shield JWT auth middleware
│   └── routes/
│       ├── categories.js
│       └── items.js
├── src/
│   ├── main.jsx              # React entry point
│   ├── App.jsx               # Root component, routing, theme
│   ├── App.css               # All styles (CSS custom properties)
│   ├── api.js                # Frontend fetch wrapper
│   ├── components/
│   │   ├── Sidebar.jsx
│   │   ├── TabContent.jsx
│   │   ├── ResourceTable.jsx
│   │   ├── DetailPanel.jsx
│   │   ├── LandingPage.jsx
│   │   └── AddItemDialog.jsx
│   └── hooks/
│       ├── useResource.js
│       └── useResizable.js
├── Dockerfile
├── entrypoint.sh
├── index.html
├── package.json
├── rio.yml                   # Rio CI/CD pipeline (PR build, app build, deploy)
├── template.config.json
├── vite.config.js
├── .env.example
├── .npmrc
└── .nvmrc
```

## Local Development

- **Data**: Books live in SQLite (`server/db.js`) at `DB_PATH` (default `./data/app.db`; a ReadWriteOnce PVC at `/app/data` in K8s). On first start the table is seeded from `config/config.local.json`.
- **Config loading**: Whisper is loaded best-effort at startup; failures are logged and the app continues.
- **Auth bypass**: Shield authentication is automatically bypassed when `NODE_ENV` is not `production`, so you do not need OIDC tokens locally.
- **Dev proxy**: The Vite dev server on port **5173** proxies all `/api/*` requests to the Express backend on port **3001**.

## Narrative Setup

Narrative provides mTLS certificates for authenticating with Whisper and other Apple services. There are two parts: **local development** (generating certs on your machine) and **Kubernetes** (CSI driver auto-provisions certs in pods).

### Prerequisites

1. **Install narrative-client**

   ```bash
   brew install apple/narrative/narrative-client
   narrative-client --version
   ```

2. **Configure AppleConnect**

   Open AppleConnect Settings > Advanced (`Cmd + Shift + Option + E`) and enable:
   - Create forwardable tickets
   - Use Narrative Touch ID identity for apple.com domain
   - Narrative identities via socket

3. **Verify your identity**

   ```bash
   memento show
   ```

   Output should include: `aprn:apple:idms:::person:<your_dsid>`

4. **Create an Access Policy**

   - Go to [appleconnect.apple.com](https://appleconnect.apple.com)
   - Select **Access Policies (Narrative)** under Delegated Access
   - Choose your system account
   - Create a policy selecting **Actor Identity** with your personal APRN

### Local Certificate Generation

Set your DSIDs in `.env` (see `.env.example`):

```bash
NARRATIVE_PERSON_DSID=your_person_dsid
NARRATIVE_SYSTEM_DSID=your_system_dsid
```

Generate certificates:

```bash
npm run cert:generate
```

This runs the identity chain (Platform → Actor → System Actor) and outputs certificates to `cert/system-actor/`. Check expiry with:

```bash
openssl x509 -in cert/system-actor/cert.pem -noout -dates
```

### Kubernetes (CSI Driver)

In production, the Helm chart uses the **Narrative CSI driver** to auto-provision TLS certificates into pods. The CSI driver is pre-installed on the `dev-slm-datahub` EKS cluster — no manual driver installation required.

However, each namespace needs a **NarrativeIssuer** CRD to tell the driver how to provision certificates. This is included in the Helm chart (`chart/templates/narrative-issuer.yaml`) and is applied automatically on `helm upgrade --install`:

```yaml
apiVersion: ais-sre.apple.com/v1beta1
kind: NarrativeIssuer
metadata:
  name: narrative-issuer
  namespace: <app-name>
spec:
  identities:
    - ref: platform
      type: platform
      domain: aws
      nameAutodetect: true
      identityAttestor: awsiid
```

If you need to apply it manually before the first Helm deploy (e.g. for debugging):

```bash
kubectl apply -f - <<EOF
apiVersion: ais-sre.apple.com/v1beta1
kind: NarrativeIssuer
metadata:
  name: narrative-issuer
  namespace: <app-name>
spec:
  identities:
    - ref: platform
      type: platform
      domain: aws
      nameAutodetect: true
      identityAttestor: awsiid
EOF
```

Once the NarrativeIssuer exists, the deployment mounts a CSI volume at `/tls` with three files:

| File | Purpose |
|------|---------|
| `tls.crt` | Client certificate |
| `tls.key` | Private key |
| `ca.crt` | CA certificate |

This is configured in `chart/templates/deployment.yaml`:

```yaml
volumes:
  - name: tls
    csi:
      readOnly: true
      driver: narrative.apple.com
      volumeAttributes:
        narrative.apple.com/type: "actor"
        narrative.apple.com/domain: "aws"
        narrative.apple.com/name: "<app-name>"
        narrative.apple.com/pod-identity: "true"
        narrative.apple.com/fs-group: "266"
```

The `narrative.apple.com/name` value is set from `values.yaml` (`narrative.name`) and is replaced by the setup script.

### Troubleshooting

| Error | Fix |
|-------|-----|
| `narrative-client not found` | `brew install apple/narrative/narrative-client` |
| `No Narrative identity found` | Enable Narrative in AppleConnect Settings > Advanced |
| `Set NARRATIVE_PERSON_DSID...` | Export DSIDs in `.env` or shell |
| `Failed to process identities` | Verify AppleConnect is running with Narrative enabled |
| Access Policy errors | Check policy exists at appleconnect.apple.com |
| Pod `CreateContainerError` with tls volume | Verify `narrative.name` in `values.yaml` matches your registered identity |
| `driver name narrative.apple.com not found` | NarrativeIssuer CRD missing from namespace — run `kubectl apply` with the manifest above |

### Links

- [Narrative Documentation](https://narrative.apple.com)
- [Narrative Tooling & Downloads](https://narrative.apple.com/support/tooling.html)
- [Narrative Troubleshooting](https://narrative.apple.com/support/troubleshooting.html)
- [Generating Narrative Certificates (AI-for-Devs)](https://pages.github.pie.apple.com/AI-for-Devs-Community/AppleClaudeCode/authentication.html#generating-narrative-certificates)
- [AppleConnect Access Policies](https://appleconnect.apple.com)

## Deployment

```bash
npm run deploy          # Full pipeline: build → ECR push → Helm upgrade
```

Or step by step:

```bash
npm run build           # Vite production build
npm run ecr:deploy      # ECR login → Docker build → push → rollout restart
npm run helm:deploy     # Helm install/upgrade into namespace
```

To preview the Helm output without deploying:

```bash
npm run helm:deploy:dry-run
```

## Customization

- **Add a tab**: Edit the `TABS`, `KEY_FIELDS`, and `TABLE_CONFIG` objects in `src/components/TabContent.jsx`. Each tab maps to a backend route and defines which columns the table displays.
- **Add an API route**: Create a new file in `server/routes/`, then register it in `server/index.js` with `app.use()`.
- **Change the design**: Edit CSS custom properties in `src/App.css`. Light and dark themes are controlled by `[data-theme]` selectors at the top of the file.
- **Update config shape**: Edit the validation logic in `server/config.js` and add corresponding keys to `config/config.local.json`.

## Template Config Reference

These keys live in `template.config.json` and are replaced project-wide by the setup script.

| Key | Default Value | Description |
|-----|---------------|-------------|
| `appName` | `platform-btp-kyma-fleet-dashboard` | npm package name and general identifier |
| `appTitle` | `Btp Kyma Fleet Dashboard` | Display title shown in the browser tab and header |
| `namespace` | `btp-kyma-fleet-dashboard` | Kubernetes namespace for Helm deployments |
| `ecrRepo` | `637248970961.dkr.ecr.us-west-2.amazonaws.com/btp-kyma-fleet-dashboard` | Full ECR repository URI for Docker images |
| `ecrRegion` | `us-west-2` | AWS region for ECR authentication |
| `basePath` | `/btp-kyma-fleet-dashboard/` | URL base path (used by Vite and the ingress) |
| `port` | `3001` | Express server listen port |
| `narrativeDomain` | `aws` | Narrative identity domain |
| `narrativeName` | `btp-kyma-fleet-dashboard` | Narrative identity name |
| `narrativeType` | `actor` | Narrative identity type (platform/host/actor) |
| `whisperSecretName` | `btp-kyma-fleet-dashboard-prod` | Whisper secret name for production |
| `whisperNamespace` | `btp-pltform-security` | Whisper namespace for secret lookup |
| `whisperSecretNameDev` | `btp-kyma-fleet-dashboard-non-prods` | Whisper secret name for non-production environments |
| `splunkIndex` | `btp_platform_apps` | Splunk index for log forwarding |
| `splunkSourcetype` | `btp_kyma_fleet_dashboard` | Splunk sourcetype for log classification |
| `shieldVip` | `sura.btp.apple.com` | Shield OIDC provider hostname for JWT validation |
| `authAllowedGroups` | `12421088` | Comma-separated Shield group IDs allowed access |
| `rioProject` | `ist-btp-platform-btp-kyma-fleet-dashboard` | Rio project name (used in badges and pipeline URLs) |
| `slackChannel` | `team-platform-foundation-dev` | Slack channel for Rio build notifications |
