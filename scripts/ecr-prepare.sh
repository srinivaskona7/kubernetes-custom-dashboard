#!/usr/bin/env bash
# Ensure the app's ECR repository exists.
# Idempotent: describe-repositories first, create-repository only on miss.
#
# Used by:
#   - rio.yml app-ecr-setup pipeline (awscli base image)
#   - scripts/push.sh (local one-shot deploys)
set -euo pipefail

REGION="${REGION:-us-west-2}"
REPO_NAME="${REPO_NAME:-btp-kyma-fleet-dashboard}"
REGISTRY_ID="${REGISTRY_ID:-637248970961}"

echo "→ Checking ECR repository ${REPO_NAME} in ${REGION}"
if aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$REGION" --registry-id "$REGISTRY_ID" >/dev/null 2>&1; then
  echo "  exists"
else
  echo "  not found — creating"
  aws ecr create-repository --repository-name "$REPO_NAME" --region "$REGION" --registry-id "$REGISTRY_ID" >/dev/null
  echo "  created"
fi
