#!/bin/bash
set -e

mkdir -p /logs

exec > >(tee -a /logs/stdout.log) \
     2> >(tee -a /logs/stderr.log >&2)

exec "$@"
