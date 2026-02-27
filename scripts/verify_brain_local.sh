#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export CLAWBRAIN_BASE_URL="${CLAWBRAIN_BASE_URL:-http://127.0.0.1:18088}"
export CLAWBRAIN_TOKEN_FILE="${CLAWBRAIN_TOKEN_FILE:-$ROOT_DIR/.local/data/secrets/api_token}"

"$ROOT_DIR/scripts/verify_brain.sh"
