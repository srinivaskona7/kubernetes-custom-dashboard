#!/usr/bin/env bash
# Wipe the entire app namespace — destroys all pods, secrets, configmaps,
# services, and any persistent volumes attached to it.
#
# Use this when you want a fully clean redeploy, e.g. after stuck pods or
# to clear out drift from a manual edit. Pair with `npm run push` to bring
# the namespace back up from scratch.
#
# Usage:
#   aws-profile dev-dev
#   CONFIRM=yes npm run wipe
#
# Refuses to run unless CONFIRM=yes is exported.
set -euo pipefail

REGION="${REGION:-us-west-2}"
CLUSTER="${CLUSTER:-dev-slm-datahub}"
NAMESPACE="${NAMESPACE:-btp-kyma-fleet-dashboard}"

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "ERROR: this will permanently delete the ${NAMESPACE} namespace and" >&2
  echo "       everything in it. Re-run with CONFIRM=yes:" >&2
  echo "         CONFIRM=yes npm run wipe" >&2
  exit 1
fi

echo "→ Updating kubeconfig for ${CLUSTER}"
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

echo "→ Deleting namespace ${NAMESPACE}"
kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=true --timeout=5m

echo "✓ Namespace ${NAMESPACE} wiped. Run 'npm run push' to redeploy."
