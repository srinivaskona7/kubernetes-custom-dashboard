#!/usr/bin/env bash
# Helm upgrade for the app release. Single source of truth for the helm
# flags — invoked by both Rio (app-deploy) and `npm run push`.
#
# Required env:
#   IMAGE_TAG     — image tag in ECR (e.g. git short-sha or ${CODE_VERSION})
#
# Optional env:
#   NAMESPACE     — default: btp-kyma-fleet-dashboard
#   RELEASE       — default: btp-kyma-fleet-dashboard
#   CLUSTER       — default: dev-slm-datahub
#   REGION        — default: us-west-2
#   WAIT_ROLLOUT  — set to "false" to skip the kubectl rollout status wait
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG must be set}"

NAMESPACE="${NAMESPACE:-btp-kyma-fleet-dashboard}"
RELEASE="${RELEASE:-btp-kyma-fleet-dashboard}"
CLUSTER="${CLUSTER:-dev-slm-datahub}"
REGION="${REGION:-us-west-2}"

echo "→ Updating kubeconfig for ${CLUSTER}"
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

echo "→ Ensuring namespace ${NAMESPACE} exists"
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

# --- Preflight: the RollingUpdate -> Recreate strategy transition -------------
#
# Kubernetes SERVER-DEFAULTS spec.strategy.rollingUpdate (maxSurge /
# maxUnavailable) onto any Deployment created while type was RollingUpdate. That
# stored sub-object becomes Forbidden the moment type is Recreate:
#
#   UPGRADE FAILED: Deployment.apps "btp-kyma-fleet-dashboard" is invalid:
#   spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy
#   `type` is 'Recreate'
#
# Helm cannot clear it, and this is not a chart bug we can template our way out
# of. Two attempts already failed in CI:
#
#   1. Setting only `type: Recreate` — Helm's three-way merge emits a delete only
#      for fields present in its OWN previous manifest, and this field never was
#      (the API server set it), so nothing removes it.
#   2. Adding an explicit `rollingUpdate: null` to the chart — Helm builds the
#      patch with CreateThreeWayMergePatch, whose change pass runs with
#      IgnoreDeletions, so a null in the desired manifest is stripped before the
#      patch is sent. The chart keeps the null anyway: it is correct for a fresh
#      install, where it unmarshals to a nil pointer.
#
# kubectl does NOT filter the null — it sends the patch as given and the API
# server applies merge-patch semantics, where null removes the member. So
# reconcile the live object here, before handing over to Helm.
#
# Idempotent and self-limiting: skipped when the Deployment does not exist yet
# (fresh install), when the chart does not ask for Recreate, and when the live
# object no longer carries the sub-object.
DESIRED_STRATEGY="$(helm template "$RELEASE" ./chart --set image.tag="$IMAGE_TAG" 2>/dev/null \
  | awk '/^kind: Deployment$/{d=1} d && /^  strategy:/{s=1; next} s && /^    type:/{print $2; exit}')"

if [[ "$DESIRED_STRATEGY" == "Recreate" ]] && kubectl get deployment "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
  LIVE_ROLLING_UPDATE="$(kubectl get deployment "$RELEASE" -n "$NAMESPACE" \
    -o jsonpath='{.spec.strategy.rollingUpdate}' 2>/dev/null || true)"
  if [[ -n "$LIVE_ROLLING_UPDATE" ]]; then
    echo "→ Preflight: live Deployment still carries spec.strategy.rollingUpdate"
    echo "    ${LIVE_ROLLING_UPDATE}"
    echo "  Forbidden under Recreate and not removable by Helm — stripping it so the upgrade can apply."
    kubectl patch "deployment/${RELEASE}" -n "$NAMESPACE" --type=merge \
      -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
  fi
fi

echo "→ Helm upgrade ${RELEASE} (tag=${IMAGE_TAG})"
helm upgrade --install "$RELEASE" ./chart \
  -n "$NAMESPACE" --create-namespace \
  --set image.tag="$IMAGE_TAG"

if [[ "${WAIT_ROLLOUT:-true}" == "true" ]]; then
  echo "→ Waiting for rollout"
  kubectl rollout status "deployment/${RELEASE}" -n "$NAMESPACE" --timeout=5m
fi

echo "✓ Deployed ${IMAGE_TAG} to ${NAMESPACE}"
