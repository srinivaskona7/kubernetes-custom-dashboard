#!/usr/bin/env bash
# Build, push, and deploy the app image to EKS — local one-shot deploy.
#
# Reuses scripts/ecr-prepare.sh and scripts/helm-deploy.sh so the pipeline
# (rio.yml) and the local flow stay in lock-step.
#
# Tags the image with the current git short-sha so each deploy is uniquely
# identifiable. Adds a -dirty marker if the working tree has uncommitted
# changes.
#
# Usage:
#   aws-profile dev-dev
#   npm run push
set -euo pipefail

ECR_ACCOUNT="637248970961"
REGION="${REGION:-us-west-2}"
NAMESPACE="${NAMESPACE:-btp-kyma-fleet-dashboard}"
RELEASE="${RELEASE:-btp-kyma-fleet-dashboard}"
REPO_NAME="${REPO_NAME:-btp-kyma-fleet-dashboard}"
REPO="${ECR_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}"

TAG="$(git rev-parse --short HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  TAG="${TAG}-dirty"
fi

# 1. Make sure the ECR repo exists (matches Rio's app-ecr-setup behaviour).
REGION="$REGION" REPO_NAME="$REPO_NAME" REGISTRY_ID="$ECR_ACCOUNT" \
  bash scripts/ecr-prepare.sh

# 2. ECR docker login.
echo "→ Logging into ECR"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ECR_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

# 3. Build and push.
echo "→ Building image ${REPO}:${TAG}"
docker buildx build --platform=linux/amd64 --load \
  -t "${REPO}:${TAG}" -t "${REPO}:latest" \
  -f Dockerfile .

echo "→ Pushing ${REPO}:${TAG} and :latest"
docker push "${REPO}:${TAG}"
docker push "${REPO}:latest"

# 4. Hand off to the shared helm-deploy script (same one Rio calls).
IMAGE_TAG="$TAG" \
NAMESPACE="$NAMESPACE" \
RELEASE="$RELEASE" \
REGION="$REGION" \
  bash scripts/helm-deploy.sh

kubectl get pods -n "$NAMESPACE"
