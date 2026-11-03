# Kubernetes Fleet Dashboard

A read-only web console for a fleet of Kubernetes clusters. It talks to each
cluster's API server using standard Kubernetes resources, so it runs unchanged
against **EKS, AKS, GKE, kind, minikube and OpenShift**.

One Node process serves both the REST API (`/api/fleet/*`) and the built React
frontend. Storage is SQLite on a PersistentVolumeClaim.

## What it reads

| Area | Source |
|---|---|
| Clusters, nodes, namespaces, pods, events | `v1` core API |
| Workloads, rollouts, replica sets | `apps/v1`, `batch/v1` |
| HPA, PDB | `autoscaling/v2`, `policy/v1` |
| Ingress, NetworkPolicy, IngressClass | `networking.k8s.io/v1` |
| Gateway, HTTPRoute | `gateway.networking.k8s.io/v1` (optional) |
| VirtualService, Gateway, DestinationRule | `networking.istio.io/v1` (optional) |
| Certificates | `cert-manager.io/v1` (optional) |
| Storage classes, PVs, PVCs, quotas | `storage.k8s.io/v1`, `v1` |
| Node and pod usage | `metrics.k8s.io` (optional — needs metrics-server) |
| Helm releases | Secrets of type `helm.sh/release.v1` |

Optional groups are read best-effort: when the CRD is absent the panel reports
"not installed" instead of failing the request. There are no Kyma, SAP BTP,
Gardener, Kyverno, OPA/Gatekeeper or cloud-provider-specific dependencies.

The dashboard is **strictly read-only** with respect to workloads. It never
scales, restarts or patches anything in a cluster. The only writes are to its
own fleet registry Secret in its own namespace.

## Local development

Requires Node 26 (`nvm use`).

```bash
cp .env.example .env
npm ci
npm run dev            # vite on :5173 proxying /api to :3001
```

Production-style run:

```bash
npm run build
AUTH_MODE=none NODE_ENV=development npm start
```

`AUTH_MODE=none` is refused when `NODE_ENV=production`; the process exits
rather than serving an unauthenticated API.

## Authentication

Set `AUTH_MODE=oidc` (the chart default) and point it at any OIDC issuer:

| Variable | Meaning |
|---|---|
| `AUTH_MODE` | `none` or `oidc` |
| `OIDC_JWKS_URL` | required for `oidc`; the issuer's JWKS endpoint |
| `OIDC_ISSUER` | optional `iss` check |
| `OIDC_AUDIENCE` | optional `aud` check |
| `ALLOWED_GROUPS` | comma-separated `groups` claim values allowed to read; empty = any authenticated user |
| `FLEET_ADMIN_GROUPS` | groups allowed to add/remove clusters and renew credentials; empty = nobody |

Works with Keycloak, Okta, Entra ID, Auth0, Google, Dex — anything that
publishes a JWKS and puts group membership in a `groups` claim.

## Container image

Public base images only (`node:26-alpine`), multi-stage, non-root (uid 1000),
with a `HEALTHCHECK` that uses Node itself so no `curl` is needed.

```bash
npm run docker:build                       # k8s-fleet-dashboard:latest
docker run --rm -p 3001:3001 \
  -e AUTH_MODE=none -e NODE_ENV=development \
  k8s-fleet-dashboard:latest
```

Push to whichever registry your cluster pulls from:

```bash
docker tag k8s-fleet-dashboard:latest ghcr.io/<org>/k8s-fleet-dashboard:1.0.0
docker push ghcr.io/<org>/k8s-fleet-dashboard:1.0.0
```

## Helm

```bash
helm upgrade --install fleet-dashboard ./chart \
  -n fleet-dashboard --create-namespace \
  --set image.repository=ghcr.io/<org>/k8s-fleet-dashboard \
  --set image.tag=1.0.0 \
  --set auth.mode=oidc \
  --set auth.jwksUrl=https://login.example.com/.well-known/jwks.json \
  --set auth.issuer=https://login.example.com/ \
  --set auth.audience=k8s-fleet-dashboard \
  --set auth.allowedGroups=platform-engineering
```

`helm template ./chart` and `helm lint ./chart` both pass offline. Everything
the chart emits is standard API: `ServiceAccount`, `ClusterRole` +
`ClusterRoleBinding`, namespaced `Role` + `RoleBinding`, `Service`, `Deployment`,
`PersistentVolumeClaim`, optional `Ingress`, `HPA`, `NetworkPolicy`, `PDB`.

### Per-cloud notes

| | EKS | AKS | GKE |
|---|---|---|---|
| StorageClass | leave empty (gp2/gp3 default) | leave empty (`managed-csi`) | leave empty (`standard-rwo`) |
| Ingress | `ingressClassName: alb` + [ALB annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/) | `ingressClassName: webapprouting.kubernetes.azure.com` | `ingressClassName: gce` |
| Workload identity | `serviceAccount.annotations["eks.amazonaws.com/role-arn"]` | `azure.workload.identity/client-id` + pod label | `iam.gke.io/gcp-service-account` |
| Metrics | install metrics-server or the usage panels stay empty | built in | built in |

The chart defaults to **no** node selector, zone pinning, storage class or
cloud annotation, which is what makes it portable. Provider tuning belongs in a
`values-<cloud>.yaml` you keep alongside your deployment.

### RBAC

`rbac.readSecrets` is `true` by default because Helm release metadata lives in
Secrets. Every value that reaches the browser is redacted server-side, but the
grant itself is cluster-wide read on Secrets. Set it to `false` if your policy
forbids that — the Helm tab will then report the reads as unavailable while
every other panel keeps working.

## Verification

```bash
npm test                 # vitest: server collectors + src unit tests
npx tsc --noEmit         # frontend type check
npm run build            # vite production bundle
helm lint ./chart
helm template ./chart
```

## API surface

`GET /api/health` — liveness/readiness, always unauthenticated.

Authenticated under `/api/fleet`:

```
GET  /clusters                          POST /clusters
GET  /clusters/:id                      DELETE /clusters/:id
GET  /clusters/:id/overview             GET  /clusters/:id/summary
GET  /clusters/:id/workloads            GET  /workloads
GET  /clusters/:id/pods                 GET  /clusters/:id/logs
GET  /clusters/:id/events               GET  /clusters/:id/topology
GET  /clusters/:id/networking           GET  /networking
GET  /clusters/:id/storage              GET  /storage
GET  /clusters/:id/security             GET  /security
GET  /clusters/:id/autoscaling          GET  /autoscaling
GET  /clusters/:id/certificates         GET  /certificates
GET  /clusters/:id/mesh                 GET  /mesh
GET  /clusters/:id/capacity             GET  /capacity
GET  /clusters/:id/cost                 GET  /cost
GET  /clusters/:id/reliability          GET  /reliability
GET  /clusters/:id/observability        GET  /observability
GET  /clusters/:id/helm/releases        GET  /clusters/:id/helm/releases/:ns/:name/manifest
GET  /clusters/:id/resource-yaml        GET  /clusters/:id/traffic-errors
GET  /clusters/:id/traces               GET  /summary
GET  /tokens                            POST /tokens/:id/renew
GET  /me                                GET  /compliance
GET  /drift                             GET  /report
```

Every read is fan-out shaped: an unreachable cluster returns a slot with
`ok: false` and a typed error rather than failing the whole response.

## Layout

```
server/            Express API
  fleet/           cluster client, collectors, registry, auth
  routes/          /api/status
src/               React frontend (Vite, Tailwind, react-router)
chart/             Helm chart
config/            seed data for the local SQLite database
```
