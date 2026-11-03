#!/bin/bash
set -ex

mkdir -p ~/.aws/cli/process-creds-cache
ln -s ${BUILD_SECRETS_PATH}/aws-config ~/.aws/config
ln -s ${BUILD_SECRETS_PATH}/aws-credentials ~/.aws/credentials
