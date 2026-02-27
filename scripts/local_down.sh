#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="${CLAWBRAIN_LOCAL_PROJECT_NAME:-clawbrain-local}"

docker compose \
  -p "$PROJECT_NAME" \
  -f "$ROOT_DIR/docker-compose.yml" \
  -f "$ROOT_DIR/docker-compose.local.yml" \
  down "$@"
